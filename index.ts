import { ClobClient, Side } from "@polymarket/clob-client";
import { Wallet } from "ethers";

const privateKey = process.env.PRIVATE_KEY!;
if (!privateKey) throw new Error("PRIVATE_KEY not found in .env file");

const wallet = new Wallet(privateKey);
const POLYMARKET_DATA_STREAM_URL = "wss://ws-live-data.polymarket.com";
const MARKET = "btc/usd";
const RANDOM_START_TIME_S = 1772568900;

const clobClient = new ClobClient("https://clob.polymarket.com", 137, wallet);

let lastMarketEndPrice = 0;
let lastActiveMarketId: null | string = null;
let orderPlacedForMarket: { [key: string]: boolean } = {};
let trades: any[] = [];

// ── Frontend WebSocket server ─────────────────────────────────
const frontendClients = new Set<any>();

const bunServer = Bun.serve({
  port: 3001,
  fetch(req: Request) {
    const url = new URL(req.url);
  
    // Serve dashboard
    if (url.pathname === "/" || url.pathname === "/dashboard") {
      return new Response(Bun.file("dashboard.html"), {
        headers: { "Content-Type": "text/html" },
      });
    }
  
    // ✅ Dedicated WebSocket path
    if (url.pathname === "/ws") {
      const success = bunServer.upgrade(req);
      if (success) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
  
    return new Response("PolyBot running!");
  },
  websocket: {
    open(client: any) {
      frontendClients.add(client);
      console.log("📺 Frontend connected");
    },
    close(client: any) {
      frontendClients.delete(client);
      console.log("📺 Frontend disconnected");
    },
    message(client: any, msg: any) {},
  },
});

console.log(`🖥️  Frontend server running at ws://localhost:${bunServer.port}`);

// Broadcast to all connected frontend clients
function broadcast(data: object) {
  const msg = JSON.stringify(data);
  for (const c of frontendClients) {
    c.send(msg);
  }
}

// ── Polymarket helpers ────────────────────────────────────────
async function getTokenIdForMarket(slug: string): Promise<string | null> {
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`);
    const data = await res.json() as any[];
    if (data && data[0]?.clobTokenIds) return data[0].clobTokenIds[0];
  } catch (e) {
    console.error("Failed to fetch token ID:", e);
  }
  return null;
}

async function createOrderForMarket(marketId: string, side: Side, price: number, size: number) {
  const tokenId = await getTokenIdForMarket(marketId);
  if (!tokenId) {
    console.error("Could not find token ID for market:", marketId);
    broadcast({ type: "trade", action: "ERROR", marketId, reason: "Token ID not found" });
    return;
  }

  console.log(`Placing ${side} order on ${marketId} at price ${price}`);
  broadcast({ type: "trade", action: side === Side.BUY ? "BUY" : "SELL", marketId, price, size, status: "PLACING" });

  try {
    const order = await clobClient.createOrder({ tokenID: tokenId, side, price, size });
    const result = await clobClient.postOrder(order);
    console.log("✅ Order placed:", result);

    const trade = { action: side === Side.BUY ? "BUY" : "SELL", marketId, price, size, status: "PLACED", time: Date.now() };
    trades.push(trade);
    broadcast({ type: "trade", ...trade });
  } catch (e: any) {
    console.error("❌ Order failed:", e);
    broadcast({ type: "trade", action: side === Side.BUY ? "BUY" : "SELL", marketId, price, size, status: "FAILED", error: e?.message });
  }
}

// ── Polymarket live feed ──────────────────────────────────────
const polyWs = new WebSocket(POLYMARKET_DATA_STREAM_URL);

polyWs.onopen = () => {
  console.log("✅ Connected to Polymarket live feed");
  polyWs.send(`{"action":"subscribe","subscriptions":[{"topic":"crypto_prices_chainlink","type":"update","filters":"{\\"symbol\\":\\"${MARKET}\\"}"}]}`);
};

polyWs.onmessage = (event) => {
  if (!event.data) return;

  const json = JSON.parse(event.data);
  const value: number = json.payload?.value;
  if (!value) return;

  const nowSec = Math.floor(Date.now() / 1000);
  const timePassed = Math.floor(((Date.now() - new Date(1772544600000).getTime()) % 300000) / 1000);
  const timeLeft = 300 - timePassed;
  const currentActiveMarketId =
    `btc-updown-5m-` +
    Number(RANDOM_START_TIME_S + 300 * Math.floor((nowSec - RANDOM_START_TIME_S) / 300));

  if (!lastActiveMarketId) {
    lastActiveMarketId = currentActiveMarketId;
    lastMarketEndPrice = value;
  }

  if (currentActiveMarketId !== lastActiveMarketId) {
    console.log(`🔄 New market window: ${currentActiveMarketId}`);
    lastActiveMarketId = currentActiveMarketId;
    lastMarketEndPrice = value;
    broadcast({ type: "window", marketId: currentActiveMarketId, baseline: value });
  }

  console.log(`⏱ Time left: ${timeLeft}s | BTC: $${value} | Baseline: $${lastMarketEndPrice}`);

  broadcast({
    type: "price",
    price: value,
    baseline: lastMarketEndPrice,
    timeLeft,
    marketId: currentActiveMarketId,
  });

  if (timeLeft <= 30 && lastMarketEndPrice && !orderPlacedForMarket[currentActiveMarketId]) {
    orderPlacedForMarket[currentActiveMarketId] = true;
    const diff = value - lastMarketEndPrice;

    if (diff < -100) {
      console.log("📉 Price dropped, placing SELL order");
      broadcast({ type: "decision", action: "SELL", reason: `BTC dropped $${Math.abs(diff).toFixed(0)}`, marketId: currentActiveMarketId });
      createOrderForMarket(currentActiveMarketId, Side.SELL, 0.9, 10);
    } else if (diff > 100) {
      console.log("📈 Price rose, placing BUY order");
      broadcast({ type: "decision", action: "BUY", reason: `BTC rose $${diff.toFixed(0)}`, marketId: currentActiveMarketId });
      createOrderForMarket(currentActiveMarketId, Side.BUY, 0.9, 10);
    } else {
      console.log("↔️ Price change too small, skipping trade");
      broadcast({ type: "decision", action: "SKIP", reason: `Movement $${Math.abs(diff).toFixed(0)} < $100 threshold`, marketId: currentActiveMarketId });
    }
  }
};

polyWs.onerror = (err) => console.error("WebSocket error:", err);
polyWs.onclose = () => console.log("WebSocket closed");

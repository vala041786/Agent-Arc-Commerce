import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // In-memory simulation of Circle / Arc state
  let wallets = {
    researcher: {
      address: "0xAgent_Researcher_Arc_7f2a",
      balance: 100.0, // USDC
      name: "Researcher Agent"
    },
    provider: {
      address: "0xAgent_Knowledge_Arc_9e1b",
      balance: 50.0, // USDC
      name: "Knowledge Provider Agent"
    }
  };

  let transactions: any[] = [];

  // API Routes
  app.get("/api/wallets", (req, res) => {
    res.json(wallets);
  });

  app.post("/api/pay", (req, res) => {
    const { amount, from, to, reference } = req.body;
    const simulateChaos = req.headers['x-simulate-chaos'] === 'true';
    
    // Random 20% failure rate if chaos is enabled to test retry logic
    if (simulateChaos && Math.random() < 0.2) {
      return res.status(503).json({ error: "Arc Network Congestion: Node Timed Out" });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    if (wallets.researcher.balance < amount) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // Process simulated nanopayment
    wallets.researcher.balance -= amount;
    wallets.provider.balance += amount;

    const tx = {
      id: `arc_tx_${Math.random().toString(36).substring(2, 11)}`,
      amount,
      from: from || wallets.researcher.address,
      to: to || wallets.provider.address,
      timestamp: new Date().toISOString(),
      reference,
      fee: 0.0001, // Flat low fee on Arc
      status: "SETTLED"
    };

    transactions.unshift(tx);
    res.json(tx);
  });

  app.get("/api/transactions", (req, res) => {
    res.json(transactions.slice(0, 50));
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`NeuroLink Server running on http://localhost:${PORT}`);
  });
}

startServer();

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Wallet as WalletIcon, 
  Activity, 
  Send, 
  ShieldCheck, 
  Database, 
  Cpu, 
  Zap,
  Terminal,
  ArrowRightLeft,
  ChevronRight,
  Loader2
} from 'lucide-react';
import { researcherAgent, knowledgeAgent } from './lib/gemini';
import { Wallet, Transaction, Message } from './lib/types';

export default function App() {
  const [researcherWallet, setResearcherWallet] = useState<Wallet | null>(null);
  const [providerWallet, setProviderWallet] = useState<Wallet | null>(null);
  const [messages, setMessages] = useState<Message[]>(() => {
    const saved = localStorage.getItem('neurolink_messages');
    return saved ? JSON.parse(saved) : [];
  });
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState("");
  const [input, setInput] = useState("");
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [pendingQuery, setPendingQuery] = useState("");
  const [protocolStatus, setProtocolStatus] = useState<'IDLE' | 'QUERYING' | 'SETTLING' | 'DELIVERING' | 'ERROR'>('IDLE');
  const [chaosMode, setChaosMode] = useState(false);
  const [txFilter, setTxFilter] = useState<'ALL' | 'SETTLED' | 'PENDING' | 'FAILED'>('ALL');
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem('neurolink_messages', JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    fetchWallets();
    fetchTransactions();
    const interval = setInterval(() => {
      fetchWallets();
      fetchTransactions();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 100);
    return () => clearTimeout(timer);
  }, [messages, protocolStatus]);

  const fetchWallets = async () => {
    try {
      const res = await fetch('/api/wallets');
      const data = await res.json();
      setResearcherWallet(data.researcher);
      setProviderWallet(data.provider);
    } catch (err) {
      console.error("Failed to fetch wallets", err);
    }
  };

  const fetchTransactions = async () => {
    try {
      const res = await fetch('/api/transactions');
      const data = await res.json();
      setTransactions(data);
    } catch (err) {
      console.error("Failed to fetch transactions", err);
    }
  };

  const startLoop = async (e?: React.FormEvent, retryQuery?: string) => {
    if (e) e.preventDefault();
    const queryToUse = retryQuery || input;
    if (!queryToUse || isProcessing) return;

    // Direct proceed if it's a retry, otherwise show confirmation
    if (!retryQuery) {
      setPendingQuery(queryToUse);
      setShowConfirmation(true);
      return;
    }

    executeLoop(queryToUse);
  };

  const executeLoop = async (queryToUse: string) => {
    setLastQuery(queryToUse);
    setInput("");
    setIsProcessing(true);
    setError(null);
    setShowConfirmation(false);
    setProtocolStatus('QUERYING');

    const nanopaymentAmount = 0.01;
    const maxRetries = 3;

    const payWithRetry = async (attempt: number = 0): Promise<any> => {
      // Optimistic "PENDING" transaction for UI
      if (attempt === 0) {
        setProtocolStatus('SETTLING');
        const pendingTx: Transaction = {
          id: `arc_pending_${Math.random().toString(36).substring(2, 11)}`,
          amount: nanopaymentAmount,
          from: researcherWallet?.address || "0x...",
          to: providerWallet?.address || "0x...",
          timestamp: new Date().toISOString(),
          reference: `Query: ${queryToUse.substring(0, 20)}...`,
          fee: 0.0001,
          status: 'PENDING'
        };
        setTransactions(prev => [pendingTx, ...prev]);
      }

      try {
        const payRes = await fetch('/api/pay', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-simulate-chaos': chaosMode ? 'true' : 'false'
          },
          body: JSON.stringify({
            amount: nanopaymentAmount,
            reference: `Query: ${queryToUse.substring(0, 20)}...`
          })
        });

        if (!payRes.ok) {
          const errorData = await payRes.json().catch(() => ({ error: payRes.statusText }));
          const status = payRes.status;
          
          console.error(`Arc Settlement Attempt ${attempt + 1} failed:`, {
            status,
            error: errorData.error,
            timestamp: new Date().toISOString()
          });

          if (attempt < maxRetries) {
            // Dynamic delay: Network congestion (503) or Rate limit (429) gets longer delay
            const baseDelay = (status === 503 || status === 429) ? 2000 : 1000;
            const delay = Math.pow(2, attempt) * baseDelay;
            
            setError(`Settlement Failed: ${errorData.error}. Retrying in ${delay / 1000}s... (Attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return payWithRetry(attempt + 1);
          }
          throw new Error(errorData.error || "Arc Settlement Failed");
        }

        return await payRes.json();
      } catch (err) {
        if (attempt < maxRetries && !(err instanceof Error && err.message.includes("Insufficient balance"))) {
          console.error(`Arc Settlement Network Error (Attempt ${attempt + 1}):`, err);
          const delay = Math.pow(2, attempt) * 1000;
          setError(`Network Error. Retrying in ${delay / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          return payWithRetry(attempt + 1);
        }
        throw err;
      }
    };

    try {
      // 1. Researcher initiates (Gemini Call)
      setProtocolStatus('QUERYING');
      const researcherQuery = await researcherAgent(`Formalize this user intent into a technical research query for a Knowledge Provider: "${queryToUse}". Emphasize that you are ready to settle 0.01 USDC via Arc.`);
      
      const resMsg: Message = { role: 'researcher', content: researcherQuery };
      setMessages(prev => [...prev, resMsg]);

      // 2. Immediate Nanopayment with Retry Logic
      const tx = await payWithRetry();
      
      // Update local state with payment verification
      setMessages(prev => prev.map((m, i) => (m.role === 'researcher' && !m.paymentId) ? { ...m, paymentId: tx.id } : m));
      fetchWallets();
      fetchTransactions();
      setError(null);

      // 3. Provider responds
      setProtocolStatus('DELIVERING');
      const response = await knowledgeAgent(`
        PROTOCOL VERIFICATION:
        - Status: SETTLED
        - Amount: ${nanopaymentAmount} USDC
        - Network: Arc-v1 Mainnet
        - TX_ID: ${tx.id}
        
        QUERY: ${researcherQuery}
        
        Requirement: Provide the FULL Technical Delivery. Include specific architectural patterns, benchmarks, or code snippets requested.
      `);
      const provMsg: Message = { role: 'provider', content: response };
      setMessages(prev => [...prev, provMsg]);
      setProtocolStatus('IDLE');

    } catch (err) {
      console.error("Agent loop failed", err);
      setProtocolStatus('ERROR');
      setError(err instanceof Error ? err.message : "An unexpected failure occurred in the agentic loop.");
    } finally {
      setIsProcessing(false);
    }
  };

  const filteredTransactions = transactions.filter(tx => {
    if (txFilter === 'ALL') return true;
    return tx.status === txFilter;
  });

  return (
    <div className="min-h-screen bg-arc-bg text-slate-200 font-sans selection:bg-arc-accent selection:text-white">
      <AnimatePresence>
        {showConfirmation && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-arc-header border border-arc-border p-8 rounded-2xl max-w-md w-full shadow-2xl relative overflow-hidden"
            >
              <div className="absolute top-0 left-0 w-1 h-full bg-arc-accent" />
              <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2 uppercase tracking-tight">
                <ShieldCheck className="w-5 h-5 text-arc-accent" /> Handshake Confirmation
              </h3>
              <div className="space-y-4 mb-8">
                <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-800">
                  <span className="text-[10px] text-slate-500 uppercase font-bold block mb-2">Nanopayment Amount</span>
                  <div className="flex items-baseline gap-1.5 text-arc-accent font-bold">
                    <span className="text-2xl">0.0100</span>
                    <span className="text-xs">USDC</span>
                  </div>
                </div>
                <div>
                  <span className="text-[10px] text-slate-500 uppercase font-bold block mb-1">Transaction Ref</span>
                  <p className="text-xs text-slate-300 italic">"Query: {pendingQuery.substring(0, 30)}..."</p>
                </div>
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Proceeding will authorize a sub-cent settlement via the Arc network. Fees are predictable and finality is deterministic.
                </p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowConfirmation(false)}
                  className="flex-1 py-3 border border-slate-800 rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-slate-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => executeLoop(pendingQuery)}
                  className="flex-1 py-3 bg-arc-accent hover:bg-cyan-500 text-white rounded-xl text-xs font-bold uppercase tracking-widest shadow-lg shadow-arc-accent/20 transition-all font-mono"
                >
                  Verify & Pay
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="h-16 border-b border-arc-border flex items-center justify-between px-8 bg-arc-header sticky top-0 z-50">
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center font-bold text-white text-xs shadow-lg shadow-cyan-500/20">ARC</div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-white flex items-center gap-2">
              NeuroLink <span className="text-slate-500 font-normal hidden sm:inline text-sm border-l border-slate-800 pl-2 ml-1">Agentic Economy Engine</span>
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <button 
            onClick={() => {
              if (confirm("Clear all messages and transaction cache?")) {
                localStorage.removeItem('neurolink_messages');
                setMessages([]);
                setError(null);
              }
            }}
            className="text-[10px] text-slate-500 hover:text-red-400 font-bold uppercase tracking-wider transition-colors"
          >
            Reset Session
          </button>
          <div className="hidden md:flex items-center gap-2 px-3 py-1 bg-green-500/10 border border-green-500/20 rounded-full">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_8px_#22c55e]"></div>
            <span className="text-[10px] uppercase font-bold text-green-500 tracking-wider">Settlement Active (Arc)</span>
          </div>
          <div className="text-xs font-mono text-slate-400">v1.2.0-beta</div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto min-h-screen flex flex-col">
        <div className="sticky top-16 z-40 bg-arc-bg/80 backdrop-blur-xl border-b border-arc-border/30">
          <ProtocolVisualizer status={protocolStatus} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 p-6 flex-1">
          {/* Main Agent Arena (Center Focus) */}
          <section className="lg:col-span-8 flex flex-col gap-6">
            <div className="bg-[#0B0E14] border border-arc-border/30 rounded-2xl relative overflow-hidden flex flex-col shadow-2xl h-full">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(6,182,212,0.03),transparent)] pointer-events-none" />
              
              <div className="p-6 space-y-6 scroll-smooth">
                {messages.length === 0 && (
                  <div className="h-[400px] flex flex-col items-center justify-center text-slate-600">
                    <Activity className="w-12 h-12 mb-4 opacity-20" />
                    <p className="text-sm font-medium tracking-wide uppercase opacity-30">Awaiting agentic handshake...</p>
                  </div>
                )}
                
                <AnimatePresence>
                  {messages.map((msg, idx) => (
                    <motion.div
                      key={idx}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`flex gap-4 ${msg.role === 'researcher' ? 'flex-row' : 'flex-row-reverse'}`}
                    >
                      <div className="flex-shrink-0 mt-1">
                        <div className={`w-8 h-8 rounded-lg overflow-hidden border bg-slate-900 ${
                          msg.role === 'researcher' ? 'border-blue-500/30' : 'border-amber-500/30'
                        }`}>
                          <img 
                            src={msg.role === 'researcher' ? "https://picsum.photos/seed/arc_researcher_v1/200/200" : "https://picsum.photos/seed/arc_provider_v1/200/200"} 
                            alt={msg.role} 
                            className="w-full h-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                        </div>
                      </div>
                      
                      <div className={`flex flex-col max-w-[85%] ${msg.role === 'researcher' ? 'items-start' : 'items-end'}`}>
                        <div className={`p-5 rounded-2xl border shadow-sm ${
                          msg.role === 'researcher' 
                            ? 'bg-slate-900/50 border-slate-800 text-slate-200 rounded-tl-none' 
                            : 'bg-arc-accent/5 border-arc-accent/20 text-slate-100 text-right rounded-tr-none'
                        }`}>
                          <div className="flex items-center gap-3 mb-3">
                            <span className={`text-[10px] uppercase font-bold tracking-widest ${
                              msg.role === 'researcher' ? 'text-blue-400' : 'text-arc-accent'
                            }`}>
                              {msg.role}
                            </span>
                            {msg.paymentId && (
                              <div className="flex items-center gap-1.5 px-2 py-0.5 bg-green-500/10 border border-green-500/20 rounded-full">
                                <Zap className="w-2.5 h-2.5 text-green-500 fill-current" />
                                <span className="text-[9px] font-mono font-bold text-green-500 uppercase tracking-tighter">Settled: {msg.paymentId.substring(0, 8)}</span>
                              </div>
                            )}
                          </div>
                          <p className="text-[14px] leading-relaxed opacity-90">{msg.content}</p>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
                <div ref={chatEndRef} />
              </div>

              <div className="p-6 bg-arc-header/80 backdrop-blur-md border-t border-arc-border/30 mt-auto sticky bottom-0 z-30">
                {!isProcessing && messages.length === 0 && (
                  <div className="mb-8">
                    <div className="flex items-center justify-between mb-4 ml-1">
                      <div className="flex items-center gap-2">
                        <Terminal className="w-3 h-3 text-arc-accent" />
                        <p className="text-[10px] uppercase font-bold text-slate-500 tracking-[0.2em]">Nanopayment Workflows</p>
                      </div>
                      <div className="flex items-center gap-1.5 px-2 py-0.5 bg-arc-accent/10 rounded-full border border-arc-accent/20">
                        <div className="w-1 h-1 rounded-full bg-arc-accent animate-ping" />
                        <span className="text-[8px] font-bold text-arc-accent uppercase tracking-tighter">Live Network</span>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {[
                        { icon: <Zap className="w-3 h-3" />, label: "Decentralized Commerce", prompt: "Explain the core benefits of decentralized agentic commerce for global scaling via nanopayments.", color: "text-blue-400" },
                        { icon: <Activity className="w-3 h-3" />, label: "AI Scalability Analysis", prompt: "Analyze how sub-cent nanopayments solve the overhead costs of traditional AI inference API calls.", color: "text-purple-400" },
                        { icon: <ShieldCheck className="w-3 h-3" />, label: "Zero-Trust Exchange", prompt: "Generate a technical specification for a zero-trust knowledge exchange between untrusted agents.", color: "text-emerald-400" },
                        { icon: <ArrowRightLeft className="w-3 h-3" />, label: "Multi-Currency Micropayments", prompt: "Compare USDC and EURC stability for sub-cent microtransactions in cross-border agentic loops.", color: "text-amber-400" },
                        { icon: <Database className="w-3 h-3" />, label: "Data-as-a-Service (DaaS)", prompt: "Propose a DaaS architecture where Knowledge Providers earn USDC per token served via Arc hooks.", color: "text-cyan-400" },
                        { icon: <Cpu className="w-3 h-3" />, label: "Privacy-Preserving Inference", prompt: "Execute a privacy-preserving AI inference task where data is encrypted before being sent to the provider.", color: "text-indigo-400" }
                      ].map((item, i) => (
                        <button
                          key={i}
                          onClick={() => executeLoop(item.prompt)}
                          disabled={isProcessing}
                          className="text-left p-4 rounded-xl border border-slate-800 bg-slate-900/40 hover:bg-arc-accent/5 hover:border-arc-accent/40 hover:scale-[1.01] active:scale-[0.99] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed group border-l-2 border-l-transparent hover:border-l-arc-accent"
                        >
                          <div className="flex items-center gap-3 mb-1">
                            <div className={`p-1.5 rounded-lg bg-slate-950 ${item.color} group-hover:text-white transition-colors border border-slate-800`}>
                              {item.icon}
                            </div>
                            <span className="text-[11px] font-bold text-slate-300 group-hover:text-white transition-colors">{item.label}</span>
                          </div>
                          <p className="text-[10px] text-slate-500 leading-relaxed truncate opacity-60 group-hover:opacity-100 transition-opacity">{item.prompt}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {error && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mb-4 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <Activity className="w-4 h-4 text-red-500" />
                      <span className="text-xs text-red-400 font-medium">{error}</span>
                    </div>
                    <button 
                      onClick={() => startLoop(undefined, lastQuery)}
                      className="text-[10px] uppercase font-bold text-white bg-red-500 px-3 py-1.5 rounded hover:bg-red-600 transition-colors"
                    >
                      Retry Loop
                    </button>
                  </motion.div>
                )}
                <form onSubmit={startLoop} className="relative w-full">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500">
                    <Terminal className="w-5 h-5 opacity-40" />
                  </div>
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Initialize agent handshake..."
                    className="w-full bg-slate-950 border border-arc-border rounded-xl py-4 pl-12 pr-32 text-sm focus:outline-none focus:ring-2 focus:ring-arc-accent/20 focus:border-arc-accent transition-all placeholder:text-slate-600 shadow-inner"
                    disabled={isProcessing}
                  />
                  <button
                    type="submit"
                    disabled={isProcessing}
                    className="absolute right-2 top-1/2 -translate-y-1/2 px-5 py-2.5 bg-arc-accent hover:bg-cyan-500 text-white font-bold text-xs rounded-lg transition-all shadow-lg shadow-arc-accent/20 disabled:opacity-50 uppercase tracking-widest flex items-center gap-2"
                  >
                    {isProcessing ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Send className="w-3.5 h-3.5" />
                    )}
                    Handshake
                  </button>
                </form>
              </div>
            </div>
          </section>

          {/* Side Info Sidebar (Agents & Ledger) */}
          <aside className="lg:col-span-4 flex flex-col gap-6">
            {/* Activated Agents */}
            <section className="bg-arc-header/40 border border-arc-border/30 p-6 rounded-2xl shadow-xl sticky top-48">
              <h2 className="text-[11px] uppercase font-bold text-slate-500 tracking-widest mb-4 flex items-center gap-2">
                <ShieldCheck className="w-3.5 h-3.5" /> Activated Agents
              </h2>
              
              <div className="space-y-4">
                <AgentCard 
                  role="Researcher" 
                  wallet={researcherWallet} 
                  active={isProcessing}
                  color="#3B82F6"
                  initialBudget={100}
                  avatarUrl="https://picsum.photos/seed/arc_researcher_v1/200/200"
                />
                <AgentCard 
                  role="Knowledge Provider" 
                  wallet={providerWallet} 
                  active={!isProcessing && messages.length > 0}
                  color="#F59E0B"
                  initialBudget={50}
                  avatarUrl="https://picsum.photos/seed/arc_provider_v1/200/200"
                />
              </div>

              <div className="mt-6 bg-slate-900/30 p-4 rounded-xl border border-arc-border">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className={`w-1.5 h-1.5 rounded-full ${chaosMode ? 'bg-red-500' : 'bg-arc-accent'} shadow-[0_0_8px_rgba(6,182,212,0.5)] animate-pulse`} />
                    <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Arc Network Status</span>
                  </div>
                  <button 
                    onClick={() => setChaosMode(!chaosMode)}
                    className={`text-[8px] font-bold px-1.5 py-0.5 rounded border transition-colors ${
                      chaosMode ? 'bg-red-500/20 border-red-500/50 text-red-500' : 'bg-slate-800 border-slate-700 text-slate-500'
                    }`}
                  >
                    CHAOS: {chaosMode ? 'ON' : 'OFF'}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-slate-950/40 p-2.5 rounded-lg border border-slate-800/50">
                    <span className="text-[9px] text-slate-500 uppercase block mb-1">Latency</span>
                    <span className="text-xs font-mono text-white">42ms</span>
                  </div>
                  <div className="bg-slate-950/40 p-2.5 rounded-lg border border-slate-800/50">
                    <span className="text-[9px] text-slate-500 uppercase block mb-1">Fee (USDC)</span>
                    <span className="text-xs font-mono text-cyan-400">0.0001</span>
                  </div>
                </div>
              </div>
            </section>

            {/* ARC Network Ledger */}
            <section className="bg-arc-header/40 border border-arc-border/30 rounded-2xl shadow-xl flex flex-col overflow-hidden">
              <div className="p-6 border-b border-arc-border/30 flex justify-between items-center bg-arc-header/20">
                <h2 className="text-[11px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-2">
                  <Database className="w-3.5 h-3.5" /> Nanopayment Stream
                </h2>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => {
                      const data = JSON.stringify(transactions, null, 2);
                      navigator.clipboard.writeText(data);
                      alert("Ledger copied to clipboard as JSON");
                    }}
                    className="text-[9px] text-slate-500 hover:text-arc-accent uppercase font-bold px-2 py-1 border border-slate-800 rounded transition-colors"
                  >
                    Export
                  </button>
                  <span className="text-[9px] font-mono bg-arc-accent/10 text-arc-accent px-2 py-0.5 rounded-full border border-arc-accent/20">Arc-v1</span>
                </div>
              </div>
              
              <div className="px-6 py-3 border-b border-arc-border bg-slate-900/20 flex gap-2 overflow-x-auto no-scrollbar">
                {(['ALL', 'SETTLED', 'PENDING', 'FAILED'] as const).map((filter) => (
                  <button
                    key={filter}
                    onClick={() => setTxFilter(filter)}
                    className={`text-[9px] uppercase font-bold px-2.5 py-1 rounded-md transition-all whitespace-nowrap ${
                      txFilter === filter 
                        ? 'bg-arc-accent text-white shadow-lg shadow-arc-accent/20 border-arc-accent' 
                        : 'text-slate-500 hover:text-slate-300 border border-slate-800 bg-slate-900/40'
                    }`}
                  >
                    {filter}
                  </button>
                ))}
              </div>
              
              <div className="p-4 space-y-3 font-mono text-[11px]">
                {filteredTransactions.length === 0 && (
                  <div className="flex flex-col items-center justify-center opacity-10 grayscale py-20">
                    <ArrowRightLeft className="w-12 h-12 mb-4" />
                    <p className="text-[10px] uppercase tracking-widest font-bold">No {txFilter !== 'ALL' ? txFilter : ''} data points</p>
                  </div>
                )}
                {filteredTransactions.map((tx) => (
                  <div key={tx.id} className={`bg-slate-900/50 border border-slate-800/60 p-4 rounded-xl hover:bg-slate-800 transition-colors group relative overflow-hidden ${
                    tx.status === 'PENDING' ? 'animate-pulse' : ''
                  }`}>
                    <div className={`absolute left-0 top-0 w-1 h-full ${
                      tx.status === 'SETTLED' ? 'bg-green-500' : 
                      tx.status === 'FAILED' ? 'bg-red-500' : 
                      'bg-amber-500'
                    } opacity-30`} />
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex flex-col">
                        <span className="text-slate-500 group-hover:text-slate-300 transition-colors text-[10px]">
                          {tx.id.substring(0, 12)}
                        </span>
                        <span className="text-[9px] text-slate-600">
                          {new Date(tx.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <span className="text-arc-accent font-bold text-sm">
                          {tx.amount.toFixed(4)} <span className="text-[10px] opacity-60">USDC</span>
                        </span>
                        <span className={`text-[8px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-tighter flex items-center gap-1 ${
                          tx.status === 'SETTLED' ? 'bg-green-500/10 text-green-500 border border-green-500/20' : 
                          tx.status === 'FAILED' ? 'bg-red-500/10 text-red-500 border border-red-500/20' : 
                          'bg-amber-500/10 text-amber-500 border border-amber-500/20 animate-pulse'
                        }`}>
                          {tx.status === 'PENDING' && <Loader2 className="w-2 h-2 animate-spin" />}
                          {tx.status}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 opacity-60 text-[9px] mb-3 bg-slate-950/40 p-1.5 rounded border border-slate-800/40">
                      <span className="truncate text-blue-400 font-mono">{tx.from.substring(0, 8)}...</span>
                      <ChevronRight className="w-2.5 h-2.5 shrink-0 text-slate-700" />
                      <span className="truncate text-amber-400 font-mono">{tx.to.substring(0, 8)}...</span>
                    </div>
                    <div className="flex justify-between items-center text-[9px] text-slate-500 border-t border-slate-800/50 pt-2 group-hover:text-slate-400 transition-colors">
                      <span className="truncate italic opacity-80">"{tx.reference}"</span>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[8px] uppercase font-bold text-slate-600">Gas:</span>
                        <span className="font-mono text-cyan-500/80">{tx.fee.toFixed(4)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="p-6 border-t border-arc-border/30 bg-slate-950/20">
                <div className="p-4 bg-cyan-900/10 border border-cyan-500/20 rounded-xl text-[10px] text-cyan-200/60 leading-relaxed text-center italic">
                  Deterministic Finality Confirmed
                </div>
              </div>
            </section>
          </aside>
        </div>
      </main>
      
      {/* Footer Status Bar */}
      <footer className="h-10 bg-arc-header border-t border-arc-border flex items-center px-8 justify-between text-[10px] font-mono text-slate-500">
        <div className="flex gap-8">
          <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-arc-accent shadow-[0_0_5px_#06B6D4]"></div> RPC: arc-mainnet.circle.io</span>
          <span className="hidden sm:inline">FINALITY: DETERMINISTIC</span>
        </div>
        <div className="flex gap-6">
          <span className="text-arc-accent font-bold uppercase tracking-widest hidden md:inline">Secure Endpoint Verified</span>
          <span className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-blue-500"></div> Circle Identity Node</span>
        </div>
      </footer>
    </div>
  );
}

function ProtocolVisualizer({ status }: { status: 'IDLE' | 'QUERYING' | 'SETTLING' | 'DELIVERING' | 'ERROR' }) {
  return (
    <div className="px-8 py-6 relative select-none">
      <div className="flex items-center justify-between max-w-2xl mx-auto relative">
        {/* Background Connection Path */}
        <div className="absolute top-[20px] left-5 right-5 h-[2px] bg-slate-800/50" />
        
        {/* Node 1: Researcher */}
        <div className="flex flex-col items-center gap-2 relative z-10 w-24">
          <motion.div 
            animate={status === 'QUERYING' ? { 
              scale: [1, 1.1, 1],
              borderColor: ['#3B82F6', '#60A5FA', '#3B82F6'],
              boxShadow: ['0 0 0px #3B82F6', '0 0 20px #3B82F6', '0 0 0px #3B82F6']
            } : {}}
            transition={{ repeat: Infinity, duration: 2 }}
            className={`w-10 h-10 rounded-xl flex items-center justify-center border-2 transition-all duration-500 ${
              status === 'QUERYING' ? 'border-blue-500 bg-blue-500/20' : 'border-slate-800 bg-slate-900'
            }`}
          >
            <Cpu className={`w-5 h-5 ${status === 'QUERYING' ? 'text-blue-400' : 'text-slate-600'}`} />
          </motion.div>
          <span className={`text-[9px] font-bold uppercase tracking-tighter transition-colors ${status === 'QUERYING' ? 'text-blue-400' : 'text-slate-500'}`}>Researcher</span>
        </div>

        {/* Connection 1 -> 2 */}
        <div className="flex-1 h-10 relative">
          <div className="absolute top-[20px] inset-x-0 h-[1px] bg-slate-800" />
          {(status === 'QUERYING' || status === 'SETTLING') && (
            <motion.div 
              initial={{ x: '-100%' }}
              animate={{ x: '100%' }}
              transition={{ repeat: Infinity, duration: 1.5, ease: "linear" }}
              className="absolute top-[20px] h-[1px] w-1/3 bg-gradient-to-r from-transparent via-cyan-400 to-transparent shadow-[0_0_8px_#22d3ee]"
            />
          )}
        </div>

        {/* Node 2: Arc Node (Clearinghouse) */}
        <div className="flex flex-col items-center gap-2 relative z-10 w-24">
          <motion.div 
            animate={status === 'SETTLING' ? { 
              rotate: [0, 90, 180, 270, 360],
              borderColor: ['#06B6D4', '#22D3EE', '#06B6D4']
            } : {}}
            transition={{ repeat: Infinity, duration: 4, ease: "linear" }}
            className={`w-10 h-10 rounded-full flex items-center justify-center border-2 transition-all duration-500 ${
              status === 'SETTLING' ? 'border-arc-accent bg-arc-accent/20' : 'border-slate-800 bg-slate-900'
            }`}
          >
            <Zap className={`w-5 h-5 ${status === 'SETTLING' ? 'text-arc-accent' : 'text-slate-600'}`} />
          </motion.div>
          <span className={`text-[9px] font-bold uppercase tracking-tighter transition-colors ${status === 'SETTLING' ? 'text-arc-accent' : 'text-slate-500'}`}>Arc Node</span>
        </div>

        {/* Connection 2 -> 3 */}
        <div className="flex-1 h-10 relative">
          <div className="absolute top-[20px] inset-x-0 h-[1px] bg-slate-800" />
          {(status === 'SETTLING' || status === 'DELIVERING') && (
            <motion.div 
              initial={{ x: '-100%' }}
              animate={{ x: '100%' }}
              transition={{ repeat: Infinity, duration: 1.5, ease: "linear" }}
              className="absolute top-[20px] h-[1px] w-1/3 bg-gradient-to-r from-transparent via-amber-400 to-transparent shadow-[0_0_8px_#fbbf24]"
            />
          )}
        </div>

        {/* Node 3: Provider */}
        <div className="flex flex-col items-center gap-2 relative z-10 w-24">
          <motion.div 
            animate={status === 'DELIVERING' ? { 
              y: [0, -4, 0],
              borderColor: ['#F59E0B', '#FBBF24', '#F59E0B']
            } : {}}
            transition={{ repeat: Infinity, duration: 2 }}
            className={`w-10 h-10 rounded-xl flex items-center justify-center border-2 transition-all duration-500 ${
              status === 'DELIVERING' ? 'border-amber-500 bg-amber-500/20' : 'border-slate-800 bg-slate-900'
            }`}
          >
            <Database className={`w-5 h-5 ${status === 'DELIVERING' ? 'text-amber-400' : 'text-slate-600'}`} />
          </motion.div>
          <span className={`text-[9px] font-bold uppercase tracking-tighter transition-colors ${status === 'DELIVERING' ? 'text-amber-400' : 'text-slate-500'}`}>Provider</span>
        </div>
      </div>

      <div className="mt-4 flex justify-center">
        <div className={`text-[10px] font-mono uppercase tracking-[0.2em] px-4 py-1 rounded-full border backdrop-blur-sm transition-all duration-500 ${
          status === 'SETTLING' ? 'text-arc-accent border-arc-accent/30 bg-arc-accent/10 shadow-[0_0_15px_rgba(6,182,212,0.1)]' :
          status === 'QUERYING' ? 'text-blue-400 border-blue-400/30' :
          status === 'DELIVERING' ? 'text-amber-400 border-amber-400/30' :
          status === 'ERROR' ? 'text-red-500 border-red-500/40 bg-red-500/10' :
          'text-slate-600 border-slate-800/50 bg-slate-900/40'
        }`}>
          {status === 'IDLE' ? 'Handshake Ready' : 
           status === 'QUERYING' ? 'Researcher -> Initiating Query' :
           status === 'SETTLING' ? 'Arc Clearinghouse -> Settling Nanopayment' :
           status === 'DELIVERING' ? 'Provider -> Responding' : 
           'Protocol Error detected'}
        </div>
      </div>
    </div>
  );
}

function AgentCard({ role, wallet, active, color, initialBudget, avatarUrl }: { role: string, wallet: Wallet | null, active: boolean, color: string, initialBudget: number, avatarUrl: string }) {
  const currentBalance = wallet?.balance || 0;
  const progress = Math.min(100, (currentBalance / initialBudget) * 100);

  return (
    <div 
      className={`p-5 rounded-xl bg-slate-900/40 border transition-all duration-500 relative overflow-hidden group ${
        active ? 'border-arc-accent/50 shadow-[0_0_25px_-10px_rgba(6,182,212,0.3)]' : 'border-slate-800/80'
      }`}
    >
      {active && (
        <div className="absolute top-0 right-0 p-2">
           <Loader2 className="w-3 h-3 text-arc-accent animate-spin" />
        </div>
      )}
      
      <div className="flex items-center gap-4 mb-5">
        <div className="w-12 h-12 bg-slate-950 rounded-xl flex items-center justify-center border border-slate-800 shadow-inner group-hover:border-slate-700 transition-colors overflow-hidden">
          <img 
            src={avatarUrl} 
            alt={role} 
            className={`w-full h-full object-cover transition-all duration-500 ${active ? 'scale-110 opacity-100' : 'opacity-60 grayscale group-hover:grayscale-0 group-hover:opacity-100'}`}
            referrerPolicy="no-referrer"
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-start mb-1">
            <h3 className="text-xs font-bold text-white uppercase tracking-wider truncate">{role}</h3>
            <span className="text-[8px] font-mono text-slate-500 whitespace-nowrap">Cap: {initialBudget}</span>
          </div>
          
          {/* Budget Progress Bar */}
          <div className="h-1 w-full bg-slate-800/50 rounded-full overflow-hidden mb-2">
            <motion.div 
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 1, ease: "easeOut" }}
              className="h-full"
              style={{ backgroundColor: color }}
            />
          </div>

          <div className="flex items-center gap-1.5">
            <div className={`w-1 h-1 rounded-full ${active ? 'bg-arc-accent animate-pulse' : 'bg-slate-600'}`} />
            <span className="text-[9px] text-slate-500 font-bold uppercase tracking-tighter">
              {active ? 'Executing Thread' : 'Awaiting Task'}
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="bg-slate-950/60 p-3 rounded-lg border border-slate-800/50 group-hover:border-slate-700/80 transition-colors">
          <div className="flex justify-between items-center mb-1">
            <span className="text-[9px] text-slate-600 uppercase font-bold tracking-widest">Arc-Balance</span>
            <WalletIcon className="w-2.5 h-2.5 text-slate-700" />
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-xl font-bold tracking-tight text-white">
              {wallet?.balance.toFixed(4) || "0.0000"}
            </span>
            <span className="text-[10px] text-slate-500 font-medium">USDC</span>
          </div>
        </div>
        
        <div className="flex items-center gap-2 opacity-50 px-1">
          <p className="text-[9px] font-mono truncate text-slate-500">
            {wallet?.address || '0x...'}
          </p>
          <div className="h-px flex-1 bg-slate-800" />
        </div>
      </div>
    </div>
  );
}


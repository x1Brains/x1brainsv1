// src/pages/CyberdyneUnlimited.tsx
// ─────────────────────────────────────────────────────────────────────────────
// CYBERDYNE UNLIMITED — Imperial Citizen Registry
// Lookup by username OR X1 wallet address. All data fetched live from API.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from "react";

// ─── RESPONSIVE ──────────────────────────────────────────────────────────────
function useIsMobile() {
  const [m, setM] = useState(typeof window !== 'undefined' ? window.innerWidth < 640 : false);
  useEffect(() => { const h = () => setM(window.innerWidth < 640); window.addEventListener('resize', h); return () => window.removeEventListener('resize', h); }, []);
  return m;
}

// ─── DATA SOURCE — GitHub Gist JSON ──────────────────────────────────────────
// jacklevin74 regenerates the JSON and pushes to this Gist whenever scores update.
// Full registry — all citizens:
const GIST_ALL = "https://gist.githubusercontent.com/jacklevin74/d4c429c3d31e190247fd79b00d92f350/raw/cyberdyne.json";

// Cache-bust disabled — Gist raw URLs may not support query params
const fetchJSON = (url: string) =>
  fetch(url, { headers: { Accept: "application/json" }, mode: "cors" });

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface Contribution {
  date:   string | null;
  item:   string;
  points: number;
}

interface Citizen {
  username:         string;
  handle:           string;
  wallet:           string | null;
  score:            number;
  tier:             string;
  rank:             number;
  verified:         boolean;
  contributions:    Contribution[];
  // Legacy compat — mapped from real data
  skills:           string[];
  passport_active:  boolean;
  passport_status?: boolean;
  telegram_id?:     number | null;
  projects?:        any[];
  last_updated?:    string;
}

interface GistMeta {
  last_updated:    string;
  total_citizens:  number;
  total_score:     number;
  source:          string;
  version:         string;
  description:     string;
}

interface TierMeta {
  min_score:   number;
  xnt_reward:  number;
  count?:      number;
}

interface ApiHealth {
  status:          string;
  citizens_count:  number;
  version?:        string;
  timestamp?:      string;
}

// ─── TIER STYLES ─────────────────────────────────────────────────────────────
const TIERS: Record<string, { glow: string; bg: string; text: string }> = {
  COSMIC:          { glow: "#ffd700", bg: "rgba(255,215,0,.10)",   text: "#ffd700" },
  HARMONIC_MASTER: { glow: "#ff6b35", bg: "rgba(255,107,53,.10)",  text: "#ff6b35" },
  HARMONIC:        { glow: "#00ffe5", bg: "rgba(0,255,229,.10)",   text: "#00ffe5" },
  ENTRAINED:       { glow: "#a78bfa", bg: "rgba(167,139,250,.10)", text: "#a78bfa" },
  INITIATE:        { glow: "#4ade80", bg: "rgba(74,222,128,.10)",  text: "#4ade80" },
  DEFAULT:         { glow: "#4ade80", bg: "rgba(74,222,128,.10)",  text: "#4ade80" },
};
const tc        = (tier = "") => { const k = Object.keys(TIERS).find(k => tier.toUpperCase().replace(/\s+/g,"_").includes(k)); return k ? TIERS[k] : TIERS.DEFAULT; };
const cleanTier = (t = "") => t.replace(/[^\w\s]/g, "").trim().split("(")[0].trim();
const sw        = (w = "") => w && w.length > 12 ? `${w.slice(0,5)}…${w.slice(-5)}` : (w || "—");
const medal     = (r: number) => r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : `#${r}`;

// ─── STYLES ───────────────────────────────────────────────────────────────────
const KF = `
  @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Share+Tech+Mono&display=swap');
  @keyframes scan    { 0%{top:-2px} 100%{top:100%} }
  @keyframes shimmer { 0%,100%{background-position:0% 50%} 50%{background-position:100% 50%} }
  @keyframes pulse   { 0%,100%{opacity:1} 50%{opacity:.4} }
  @keyframes spin    { to{transform:rotate(360deg)} }
  @keyframes fadeUp  { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:none} }
  @keyframes slideIn { from{opacity:0;transform:translateX(-6px)} to{opacity:1;transform:none} }
  ::-webkit-scrollbar{width:4px}
  ::-webkit-scrollbar-track{background:#050a0e}
  ::-webkit-scrollbar-thumb{background:#00ffe530;border-radius:2px}
  input::placeholder{color:#2a4a5a}
  input:focus{outline:none!important;border-color:rgba(0,255,229,.5)!important}
  button{transition:opacity .15s;cursor:pointer}
  button:hover{opacity:.8}
  @media(max-width:640px){
    input,select,textarea{font-size:16px!important}
    button{min-height:44px}
  }
  * { -webkit-tap-highlight-color: transparent; }
`;
const MONO = "'Share Tech Mono', monospace";
const ORB  = "'Orbitron', monospace";

// ─── ATOMS ────────────────────────────────────────────────────────────────────
const Spin = ({ label = "LOADING…" }) => (
  <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:14, padding:48, color:"#00ffe5", fontFamily:MONO, fontSize:11, letterSpacing:".3em" }}>
    <div style={{ width:32, height:32, border:"2px solid #00ffe510", borderTop:"2px solid #00ffe5", borderRadius:"50%", animation:"spin .8s linear infinite" }} />
    {label}
  </div>
);

const Rule = () => <div style={{ height:1, background:"linear-gradient(90deg,#00ffe5,transparent)", margin:"4px 0 18px" }} />;

const Badge = ({ tier }: { tier: string }) => {
  const t = tc(tier);
  return <span style={{ fontSize:9, padding:"2px 10px", border:`1px solid ${t.text}55`, background:t.bg, color:t.text, borderRadius:2, letterSpacing:".18em", fontFamily:MONO }}>{cleanTier(tier)||"UNKNOWN"}</span>;
};

const Pill = ({ label, color }: { label:string; color:string }) => (
  <span style={{ fontSize:9, padding:"2px 8px", borderRadius:2, background:`${color}18`, border:`1px solid ${color}40`, color, letterSpacing:".1em", fontFamily:MONO }}>{label}</span>
);

const Stat = ({ label, value, sub, color="#e0f0ff", dot }: { label:string; value:string; sub?:string; color?:string; dot?:boolean }) => {
  const mob = typeof window !== 'undefined' && window.innerWidth < 640;
  return (
    <div style={{ background:"rgba(255,255,255,.03)", border:"1px solid rgba(255,255,255,.07)", borderRadius:4, padding:mob?"10px 12px":"12px 16px" }}>
      <div style={{ fontSize:mob?8:9, letterSpacing:".3em", color:"#4a7a8a", textTransform:"uppercase", marginBottom:mob?4:6, fontFamily:MONO }}>{label}</div>
      <div style={{ display:"flex", alignItems:"center", gap:mob?5:7 }}>
        {dot !== undefined && <div style={{ width:7, height:7, borderRadius:"50%", flexShrink:0, background:dot?"#00ffe5":"#333", boxShadow:dot?"0 0 6px #00ffe5":"none" }} />}
        <span style={{ fontFamily:ORB, fontSize:mob?13:16, fontWeight:700, color, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{value}</span>
      </div>
      {sub && <div style={{ fontSize:mob?8:9, color:"#4a7a8a", marginTop:mob?3:4, fontFamily:MONO }}>{sub}</div>}
    </div>
  );
};

// ─── CITIZEN PROFILE CARD ─────────────────────────────────────────────────────
function ProfileCard({ c, onClose, isMobile: mob }: { c: Citizen; onClose?: () => void; isMobile?: boolean }) {
  const t       = tc(c.tier);
  const passport = c.verified ?? c.passport_status ?? c.passport_active ?? false;
  const isMobile = mob ?? (typeof window !== 'undefined' && window.innerWidth < 640);

  return (
    <div style={{ background:"#070f15", border:`1px solid ${t.glow}30`, borderRadius:8, overflow:"hidden", boxShadow:`0 0 40px ${t.glow}08`, animation:"fadeUp .3s ease" }}>
      {/* ── Header ── */}
      <div style={{ padding:isMobile?"16px 16px 12px":"24px 28px 18px", background:`linear-gradient(135deg,${t.bg},transparent)`, borderBottom:`1px solid ${t.glow}15` }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
          <div style={{ minWidth:0, flex:1 }}>
            <Badge tier={c.tier} />
            <div style={{ fontFamily:ORB, fontSize:isMobile?16:22, fontWeight:900, color:"#e0f0ff", letterSpacing:".06em", margin:"8px 0 3px", wordBreak:"break-word" }}>{c.handle || c.username}</div>
            <div style={{ fontFamily:MONO, fontSize:isMobile?9:10, color:"#4a7a8a" }}>@{c.username}</div>
            <div style={{ fontFamily:MONO, fontSize:isMobile?8:10, color:"#4a7a8a", wordBreak:"break-all", marginTop:2 }}>{c.wallet || "No wallet on file"}</div>
          </div>
          <div style={{ textAlign:"right", flexShrink:0, marginLeft:isMobile?8:16 }}>
            <div style={{ fontFamily:ORB, fontSize:isMobile?20:28, fontWeight:900, color:c.rank<=3?"#ffd700":"#4a7a8a" }}>{medal(c.rank)}</div>
            <div style={{ fontFamily:MONO, fontSize:9, color:"#4a7a8a", marginTop:2 }}>RANK #{c.rank}</div>
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ padding:isMobile?"14px 16px":"20px 28px" }}>
        {/* Stats */}
        <div style={{ display:"grid", gridTemplateColumns:isMobile?"1fr 1fr":"repeat(auto-fit,minmax(130px,1fr))", gap:isMobile?6:10, marginBottom:16 }}>
          <Stat label="Score"    value={`+${c.score?.toLocaleString()}`}       color={t.text} />
          <Stat label="Rank"     value={`#${c.rank}`}                           color={t.text} />
          <Stat label="Verified" value={passport?"VERIFIED":"UNVERIFIED"}       color={passport?"#00ffe5":"#555"} dot={passport} />
          <Stat label="Contributions" value={String(c.contributions?.length ?? 0)} sub={`${c.contributions?.reduce((s,ct) => s + ct.points, 0) ?? 0} pts total`} color="#8aabbc" />
        </div>

        {/* Contributions */}
        {!!c.contributions?.length && (
          <div style={{ marginBottom:16 }}>
            <div style={{ fontFamily:MONO, fontSize:9, letterSpacing:".3em", color:"#4a7a8a", marginBottom:8 }}>CONTRIBUTIONS ({c.contributions.length})</div>
            <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
              {c.contributions.map((ct, i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:isMobile?"flex-start":"center", flexDirection:isMobile?"column":"row", fontSize:isMobile?10:11, padding:isMobile?"8px 10px":"8px 12px", background:"rgba(255,255,255,.03)", border:"1px solid rgba(255,255,255,.06)", borderRadius:3, color:"#8aabbc", fontFamily:MONO, gap:isMobile?4:0 }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <span style={{ color:"#e0f0ff" }}>▸ {ct.item}</span>
                    {ct.date && <span style={{ color:"#3a5a6a", marginLeft:8, fontSize:9 }}>{ct.date}</span>}
                  </div>
                  <span style={{ fontFamily:ORB, fontSize:isMobile?10:11, fontWeight:700, color:t.text, marginLeft:isMobile?0:12, flexShrink:0 }}>+{ct.points}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Full wallet */}
        {c.wallet && (
          <div style={{ marginBottom:16 }}>
            <div style={{ fontFamily:MONO, fontSize:9, letterSpacing:".3em", color:"#4a7a8a", marginBottom:6 }}>WALLET ADDRESS</div>
            <div
              style={{ fontFamily:MONO, fontSize:10, color:"#4a7a8a", wordBreak:"break-all", padding:"8px 12px", background:"rgba(255,255,255,.02)", border:"1px solid rgba(255,255,255,.05)", borderRadius:3, cursor:"pointer" }}
              title="Click to copy"
              onClick={() => navigator.clipboard?.writeText(c.wallet!)}
            >
              {c.wallet}
              <span style={{ marginLeft:8, color:"#00ffe530", fontSize:9 }}>[ COPY ]</span>
            </div>
          </div>
        )}

        {onClose && (
          <button onClick={onClose} style={{ width:"100%", background:"none", border:"1px solid rgba(0,255,229,.2)", color:"#00ffe5", padding:"8px", fontFamily:MONO, fontSize:10, letterSpacing:".2em", borderRadius:3 }}>
            [ CLOSE ]
          </button>
        )}
      </div>
    </div>
  );
}

// ─── LOOKUP PANEL ─────────────────────────────────────────────────────────────
function LookupPanel({ citizens }: { citizens: Citizen[] }) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
  const [query,       setQuery]       = useState("");
  const [result,      setResult]      = useState<Citizen | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [err,         setErr]         = useState("");
  const [suggestions, setSuggestions] = useState<Citizen[]>([]);
  const [showDrop,    setShowDrop]    = useState(false);

  // Autocomplete from already-loaded registry
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2 || result) { setSuggestions([]); return; }
    setSuggestions(
      citizens.filter(c =>
        c.username.toLowerCase().includes(q) ||
        (c.handle ?? "").toLowerCase().includes(q) ||
        (c.wallet ?? "").toLowerCase().startsWith(q)
      ).slice(0, 7)
    );
  }, [query, citizens, result]);

  const lookup = async (id: string) => {
    const q = id.trim().toLowerCase();
    if (!q) return;
    setLoading(true);
    setErr("");
    setResult(null);
    setSuggestions([]);
    setShowDrop(false);
    // Search from already-loaded citizens (no API call needed)
    const found = citizens.find(c =>
      c.username.toLowerCase() === q ||
      (c.handle ?? "").toLowerCase() === q ||
      (c.wallet ?? "").toLowerCase() === q
    );
    if (found) {
      setResult(found);
    } else {
      setErr(`"${id.trim()}" not found in the Imperial Registry`);
    }
    setLoading(false);
  };

  return (
    <div style={{ marginBottom:40 }}>
      <div style={{ fontFamily:ORB, fontSize:12, fontWeight:700, letterSpacing:".3em", color:"#00ffe5", marginBottom:4 }}>◎ CITIZEN LOOKUP</div>
      <Rule />

      {/* Input row */}
      <div style={{ position:"relative", marginBottom:8 }}>
        <div style={{ display:"flex", gap:8, flexDirection:isMobile?"column":"row" }}>
          <input
            value={query}
            onChange={e => { setQuery(e.target.value); setResult(null); setErr(""); setShowDrop(true); }}
            onKeyDown={e => { if (e.key === "Enter") lookup(query); if (e.key === "Escape") setShowDrop(false); }}
            onFocus={() => setShowDrop(true)}
            placeholder={isMobile?"Username or wallet…":"Username  or  X1 wallet address…"}
            style={{ flex:1, background:"rgba(255,255,255,.04)", border:"1px solid rgba(0,255,229,.25)", borderRadius:4, padding:isMobile?"11px 14px":"13px 16px", color:"#e0f0ff", fontFamily:MONO, fontSize:isMobile?12:13 }}
          />
          <button
            onClick={() => lookup(query)}
            disabled={loading || !query.trim()}
            style={{ background:"rgba(0,255,229,.1)", border:"1px solid rgba(0,255,229,.3)", color:"#00ffe5", padding:isMobile?"11px 20px":"13px 24px", fontFamily:MONO, fontSize:11, letterSpacing:".2em", borderRadius:4, flexShrink:0, opacity:(!query.trim()||loading)?0.4:1 }}
          >
            {loading ? "…" : "SEARCH"}
          </button>
        </div>

        {/* Autocomplete */}
        {showDrop && suggestions.length > 0 && !result && (
          <div style={{ position:"absolute", top:"calc(100% + 4px)", left:0, right:0, zIndex:50, background:"#070f15", border:"1px solid rgba(0,255,229,.2)", borderRadius:4, overflow:"hidden", boxShadow:"0 8px 32px rgba(0,0,0,.5)" }}>
            {suggestions.map(c => (
              <div
                key={c.username}
                onClick={() => { setQuery(c.username); lookup(c.username); }}
                style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:isMobile?"10px 12px":"10px 14px", cursor:"pointer", borderBottom:"1px solid rgba(255,255,255,.04)", transition:"background .15s", gap:8 }}
                onMouseEnter={e => (e.currentTarget.style.background="rgba(0,255,229,.07)")}
                onMouseLeave={e => (e.currentTarget.style.background="transparent")}
              >
                <div style={{ minWidth:0, overflow:"hidden" }}>
                  <span style={{ fontFamily:ORB, fontSize:isMobile?10:12, color:"#e0f0ff" }}>{c.handle || c.username}</span>
                  {!isMobile && <span style={{ fontFamily:MONO, fontSize:9, color:"#4a7a8a", marginLeft:10 }}>{sw(c.wallet ?? "")}</span>}
                </div>
                <div style={{ display:"flex", gap:8, alignItems:"center", flexShrink:0 }}>
                  <Badge tier={c.tier} />
                  <span style={{ fontFamily:ORB, fontSize:isMobile?10:11, color:tc(c.tier).text }}>+{c.score}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ fontFamily:MONO, fontSize:10, color:"#2a4a5a", letterSpacing:".1em", marginBottom:24 }}>
        Search by <span style={{ color:"#00ffe540" }}>username</span> (e.g. x1brains) or full <span style={{ color:"#00ffe540" }}>X1 wallet address</span> — results fetched live
      </div>

      {loading && <Spin label="SCANNING IMPERIAL REGISTRY…" />}

      {err && !loading && (
        <div style={{ background:"rgba(255,68,68,.06)", border:"1px solid rgba(255,68,68,.25)", borderRadius:4, padding:"16px 20px", color:"#ff6666", fontFamily:MONO, fontSize:12 }}>
          ⚠ {err}
        </div>
      )}

      {result && !loading && (
        <ProfileCard c={result} onClose={() => { setResult(null); setQuery(""); }} />
      )}
    </div>
  );
}

// ─── LEADERBOARD ROW ─────────────────────────────────────────────────────────
function LeaderRow({ c, onClick, idx, isMobile: mob }: { c: Citizen; onClick: () => void; idx: number; isMobile?: boolean }) {
  const isMobile = mob ?? (typeof window !== 'undefined' && window.innerWidth < 640);
  const [hov, setHov] = useState(false);
  const t = tc(c.tier);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display:"grid", gridTemplateColumns:isMobile?"36px 1fr 60px":"52px 1fr auto 90px", alignItems:"center", gap:isMobile?8:14,
        padding:isMobile?"10px 12px":"13px 18px", borderRadius:4, cursor:"pointer", transition:"all .2s",
        background:hov?"rgba(0,255,229,.06)":c.rank<=3?"rgba(0,255,229,.03)":"rgba(255,255,255,.02)",
        border:`1px solid ${hov?t.glow:c.rank<=3?"rgba(0,255,229,.18)":"rgba(255,255,255,.06)"}`,
        boxShadow:hov?`0 0 20px ${t.glow}15`:"none",
        animation:`slideIn .3s ease ${Math.min(idx*0.04,0.5)}s both`,
      }}
    >
      <div style={{ fontFamily:ORB, fontSize:c.rank<=3?(isMobile?16:20):(isMobile?10:12), fontWeight:700, textAlign:"center", color:c.rank===1?"#ffd700":c.rank===2?"#c0c0c0":c.rank===3?"#cd7f32":"#4a7a8a" }}>
        {medal(c.rank)}
      </div>
      <div style={{ minWidth:0 }}>
        <div style={{ fontFamily:ORB, fontSize:isMobile?11:13, fontWeight:700, color:"#e0f0ff", letterSpacing:".04em", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.handle || c.username}</div>
        <div style={{ display:"flex", gap:4, marginTop:3, flexWrap:"wrap", alignItems:"center" }}>
          {!isMobile && c.contributions?.slice(0,2).map((ct,i) => <Pill key={i} label={ct.item.split("—")[0].trim().slice(0,25)} color={t.text} />)}
          <Badge tier={c.tier} />
          <span style={{ display:"inline-flex", alignItems:"center", gap:3 }}>
            <span style={{ width:5, height:5, borderRadius:"50%", background:c.verified?"#00ffe5":"#2a3a4a", boxShadow:c.verified?"0 0 5px #00ffe5":"none", display:"inline-block" }} />
            {!isMobile && <span style={{ fontSize:9, color:"#3a6a7a", letterSpacing:".12em", fontFamily:MONO }}>{c.verified?"VERIFIED":"UNVERIFIED"}</span>}
          </span>
        </div>
      </div>
      {!isMobile && (
        <div style={{ textAlign:"right" }}>
          <div style={{ fontSize:9, color:"#4a7a8a", fontFamily:MONO }}>{sw(c.wallet ?? "")}</div>
        </div>
      )}
      <div style={{ fontFamily:ORB, fontSize:isMobile?12:15, fontWeight:900, color:t.text, textAlign:"right", textShadow:`0 0 10px ${t.glow}70` }}>
        +{c.score.toLocaleString()}
      </div>
    </div>
  );
}

// ─── REGISTRY CARD ────────────────────────────────────────────────────────────
function RegCard({ c, onClick, idx }: { c: Citizen; onClick: () => void; idx: number }) {
  const [hov, setHov] = useState(false);
  const t = tc(c.tier);
  // Use skills if available, otherwise contribution items
  const pills: string[] = (c.skills?.length ? c.skills : c.contributions?.map(ct => ct.item) ?? []).filter(Boolean);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        background:hov?"rgba(0,255,229,.04)":"rgba(255,255,255,.02)",
        border:`1px solid ${hov?t.glow+"50":"rgba(255,255,255,.07)"}`,
        borderRadius:4, padding:"15px 17px", cursor:"pointer", transition:"all .2s",
        animation:`fadeUp .3s ease ${Math.min(idx*0.012,0.4)}s both`,
      }}
    >
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
        <div style={{ minWidth:0, flex:1 }}>
          <div style={{ fontFamily:ORB, fontSize:12, fontWeight:700, color:"#e0f0ff", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.handle || c.username}</div>
          {c.handle && c.username && c.handle !== c.username && (
            <div style={{ fontSize:9, color:"#3a6a7a", fontFamily:MONO, marginTop:1 }}>@{c.username}</div>
          )}
          <div style={{ fontSize:9, color:"#4a7a8a", fontFamily:MONO, marginTop:2 }}>{sw(c.wallet ?? "")}</div>
        </div>
        <span style={{ fontFamily:ORB, fontSize:12, fontWeight:700, color:c.rank<=3?"#ffd700":"#4a7a8a", flexShrink:0, marginLeft:8 }}>{medal(c.rank)}</span>
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:pills.length ? 0 : 0 }}>
        <div style={{ display:"flex", gap:6, alignItems:"center" }}>
          <Badge tier={c.tier} />
          <span style={{ display:"inline-flex", alignItems:"center", gap:3 }}>
            <span style={{ width:5, height:5, borderRadius:"50%", background:c.verified?"#00ffe5":"#2a3a4a", boxShadow:c.verified?"0 0 5px #00ffe5":"none", display:"inline-block" }} />
            <span style={{ fontSize:8, color:c.verified?"#4a8a7a":"#2a3a4a", letterSpacing:".1em", fontFamily:MONO }}>{c.verified?"VERIFIED":"UNVERIFIED"}</span>
          </span>
        </div>
        <span style={{ fontFamily:ORB, fontWeight:700, color:t.text, fontSize:13 }}>+{c.score.toLocaleString()}</span>
      </div>
      {pills.length > 0 && (
        <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginTop:9 }}>
          {pills.slice(0,3).map(s => <Pill key={s} label={s} color={t.text} />)}
          {pills.length > 3 && <span style={{ fontSize:9, color:"#4a7a8a", fontFamily:MONO }}>+{pills.length-3}</span>}
        </div>
      )}
      {pills.length === 0 && (
        <div style={{ marginTop:9, fontSize:9, color:"#1a3040", fontFamily:MONO, letterSpacing:".15em", fontStyle:"italic" }}>NO CONTRIBUTIONS ON FILE</div>
      )}
    </div>
  );
}

// ─── STATS BAR ────────────────────────────────────────────────────────────────
function StatsBar({ citizens, health }: { citizens: Citizen[]; health: ApiHealth | null }) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
  if (!citizens.length) return null;
  const passports  = citizens.filter(c => c.verified).length;
  const totalScore = citizens.reduce((s, c) => s + (c.score || 0), 0);
  const tierMap: Record<string, number> = {};
  citizens.forEach(c => { const t = cleanTier(c.tier)||"UNKNOWN"; tierMap[t] = (tierMap[t]??0)+1; });
  const topTier = Object.entries(tierMap).sort((a,b)=>b[1]-a[1])[0];
  return (
    <div style={{ display:"grid", gridTemplateColumns:isMobile?"1fr 1fr":"repeat(auto-fit,minmax(140px,1fr))", gap:isMobile?8:10, marginBottom:32 }}>
      <Stat label="Total Citizens"   value={String(health?.citizens_count ?? citizens.length)} color="#00ffe5" />
      <Stat label="Verified Wallets" value={String(passports)} sub={`${Math.round(passports/citizens.length*100)}% of registry`} color="#00ffe5" />
      <Stat label="Total Score Pool" value={`+${totalScore.toLocaleString()}`} color="#ffd700" />
      <Stat label="Top Tier"         value={topTier?.[0]??"—"} sub={`${topTier?.[1]??0} citizens`} color="#00ffe5" />
      <Stat label="Data Source"       value={health?.status==="healthy"?"SYNCED":"OFFLINE"} sub={health?.timestamp ? `Updated ${new Date(health.timestamp).toLocaleString()}` : undefined} color={health?.status==="healthy"?"#00ffe5":"#ff4444"} dot={health?.status==="healthy"} />
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
export default function CyberdyneUnlimited() {
  const isMobile = useIsMobile();
  const [citizens,    setCitizens]    = useState<Citizen[]>([]);
  const [leaderboard, setLeaderboard] = useState<Citizen[]>([]);
  const [filtered,    setFiltered]    = useState<Citizen[]>([]);
  const [health,      setHealth]      = useState<ApiHealth | null>(null);
  const [search,      setSearch]      = useState("");
  const [selected,    setSelected]    = useState<Citizen | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [err,         setErr]         = useState("");
  const [apiAlive,    setApiAlive]    = useState<boolean | null>(null);
  const [tab,         setTab]         = useState<"lookup"|"leaderboard"|"registry"|"analytics">("lookup");
  const [tierMeta,    setTierMeta]    = useState<Record<string, TierMeta>>({});

  const fetchAll = useCallback(async () => {
    setLoading(true); setErr("");

    try {
      const r = await fetchJSON(GIST_ALL);
      if (!r.ok) throw new Error(`Gist fetch failed: HTTP ${r.status}`);
      const data = await r.json();

      // Parse citizens array from jacklevin's format
      const raw: any[] = Array.isArray(data) ? data
        : Array.isArray(data.citizens) ? data.citizens
        : Array.isArray(data.leaderboard) ? data.leaderboard
        : [];

      if (raw.length === 0) throw new Error("No citizens found in JSON");

      // Map to our Citizen interface — preserve all original fields from jack's JSON
      const all: Citizen[] = raw.map((c: any) => ({
        ...c,  // Pass through ALL original fields first
        username:        c.username ?? c.handle ?? "unknown",
        handle:          c.handle ?? c.username ?? "unknown",
        wallet:          c.wallet || null,
        score:           c.score ?? 0,
        tier:            c.tier ?? "INITIATE",
        rank:            c.rank ?? 0,
        verified:        c.verified ?? false,
        contributions:   Array.isArray(c.contributions) ? c.contributions : [],
        // Compat: use jack's skills if present & non-empty, else derive from contributions
        skills:          (Array.isArray(c.skills) && c.skills.length > 0) ? c.skills : (Array.isArray(c.contributions) ? c.contributions.map((ct: any) => ct.item).filter(Boolean) : []),
        passport_active: c.verified ?? c.passport_active ?? false,
        passport_status: c.verified ?? c.passport_status ?? false,
        projects:        Array.isArray(c.projects) ? c.projects : (Array.isArray(c.contributions) ? c.contributions.map((ct: any) => ct.item) : []),
        last_updated:    c.last_updated ?? null,
      }));

      // Sort by score desc, assign ranks if missing
      const sorted = [...all].sort((a, b) => (b.score || 0) - (a.score || 0));
      sorted.forEach((c, i) => { if (!c.rank) c.rank = i + 1; });

      setCitizens(sorted);
      setFiltered(sorted);
      setLeaderboard(sorted.slice(0, 25));

      // Parse tier metadata from JSON (xnt_reward, min_score)
      const rawTiers = data.tiers ?? {};
      const tierCounts: Record<string, number> = {};
      sorted.forEach(c => { const t = c.tier?.toUpperCase().replace(/\s+/g,"_") || "INITIATE"; tierCounts[t] = (tierCounts[t] ?? 0) + 1; });
      const parsedTierMeta: Record<string, TierMeta> = {};
      for (const [name, val] of Object.entries(rawTiers) as [string, any][]) {
        parsedTierMeta[name] = {
          min_score:  val.min_score ?? 0,
          xnt_reward: val.xnt_reward ?? 0,
          count:      tierCounts[name] ?? 0,
        };
      }
      // If JSON didn't have tiers, build from hardcoded thresholds
      if (Object.keys(parsedTierMeta).length === 0) {
        const defaults: [string, number, number][] = [["COSMIC",3000,500],["HARMONIC_MASTER",1000,200],["HARMONIC",250,100],["ENTRAINED",50,50],["INITIATE",0,0]];
        defaults.forEach(([n,ms,xr]) => { parsedTierMeta[n] = { min_score:ms, xnt_reward:xr, count:tierCounts[n]??0 }; });
      }
      setTierMeta(parsedTierMeta);

      // Build health info from meta or data fields
      const meta = data.meta ?? {};
      setHealth({
        status: "healthy",
        citizens_count: meta.total_citizens ?? sorted.length,
        version: meta.version ?? data.version ?? "1.0",
        timestamp: meta.generated_at ?? meta.updated_at ?? data.updated_at ?? new Date().toISOString(),
      });
      setApiAlive(true);

    } catch (e: any) {
      setErr(e.message);
      setApiAlive(false);
    }

    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  useEffect(() => {
    const q = search.toLowerCase();
    setFiltered(citizens.filter(c =>
      c.username.toLowerCase().includes(q) ||
      (c.handle ?? "").toLowerCase().includes(q) ||
      (c.wallet ?? "").toLowerCase().includes(q) ||
      c.tier.toLowerCase().includes(q) ||
      c.contributions?.some(ct => ct.item.toLowerCase().includes(q))
    ));
  }, [search, citizens]);

  const TABS = [
    { key:"lookup",      label:"◎ LOOKUP" },
    { key:"leaderboard", label:"◈ LEADERBOARD" },
    { key:"registry",    label:"◉ REGISTRY" },
    { key:"analytics",   label:"◆ ANALYTICS" },
  ] as const;

  return (
    <div style={{ minHeight:"100vh", background:"#050a0e", fontFamily:MONO, color:"#c8d8e8", position:"relative", overflow:"hidden" }}>
      <style>{KF}</style>

      {/* Grid */}
      <div style={{ position:"fixed", inset:0, backgroundImage:"linear-gradient(rgba(0,255,229,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,229,.025) 1px,transparent 1px)", backgroundSize:"40px 40px", pointerEvents:"none", zIndex:0 }} />
      {/* Scanline */}
      <div style={{ position:"fixed", top:0, left:0, right:0, height:2, background:"rgba(0,255,229,.08)", animation:"scan 8s linear infinite", pointerEvents:"none", zIndex:1 }} />

      <div style={{ position:"relative", zIndex:2, maxWidth:1200, margin:"0 auto", padding:isMobile?"20px 12px 60px":"36px 24px 80px" }}>

        {/* ── HEADER ── */}
        <header style={{ textAlign:"center", marginBottom:40, animation:"fadeUp .5s ease" }}>
          <div style={{ fontFamily:ORB, fontSize:"clamp(22px,5vw,48px)", fontWeight:900, letterSpacing:".1em", lineHeight:1.1, marginBottom:8, background:"linear-gradient(135deg,#00ffe5,#0077ff,#00ffe5)", backgroundSize:"200% 200%", animation:"shimmer 4s ease infinite", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", backgroundClip:"text" }}>
            CYBERDYNE UNLIMITED
          </div>
          <div style={{ fontSize:10, letterSpacing:".35em", color:"#004455", textTransform:"uppercase", marginBottom:18, fontFamily:MONO }}>
            Imperial Citizen Registry // Live Neural Uplink
          </div>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:isMobile?6:18, flexWrap:"wrap", fontSize:isMobile?9:11, color:"#4a7a8a", letterSpacing:".1em", flexDirection:isMobile?"column":"row" }}>
            <div style={{ display:"flex", alignItems:"center", gap:isMobile?8:18, flexWrap:"wrap", justifyContent:"center" }}>
              <span style={{ display:"inline-flex", alignItems:"center", gap:6 }}>
                <span style={{ width:8, height:8, borderRadius:"50%", display:"inline-block", background:apiAlive===null?"#888":apiAlive?"#00ffe5":"#ff4444", boxShadow:apiAlive?"0 0 8px #00ffe5":apiAlive===false?"0 0 8px #ff4444":"none", animation:apiAlive?"pulse 2s ease infinite":"none" }} />
                {apiAlive===null?"PINGING…":apiAlive?"API ONLINE":"API OFFLINE"}
              </span>
              <span style={{ color:"#1a3040" }}>|</span>
              {/* ✅ FIX: wrapped (citizens.length || "…") in parens to avoid ?? + || mixing error */}
              <span>CITIZENS: <span style={{ color:"#00ffe5" }}>{health?.citizens_count ?? (citizens.length || "…")}</span></span>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:isMobile?8:18 }}>
              <span>LIVE // GITHUB DATA</span>
              <button onClick={fetchAll} style={{ background:"none", border:"1px solid rgba(0,255,229,.2)", color:"#00ffe5", padding:"4px 14px", fontFamily:MONO, fontSize:10, letterSpacing:".2em", borderRadius:2 }}>↺ REFRESH</button>
            </div>
          </div>
        </header>

        {/* ── STATS BAR ── */}
        {!loading && <StatsBar citizens={citizens} health={health} />}

        {/* ── TABS ── */}
        <div style={{ display:"flex", marginBottom:28, borderBottom:"1px solid rgba(0,255,229,.1)" }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{ background:"none", border:"none", borderBottom:tab===t.key?"2px solid #00ffe5":"2px solid transparent", color:tab===t.key?"#00ffe5":"#4a7a8a", padding:isMobile?"8px 0":"10px 22px", fontFamily:ORB, fontSize:isMobile?8:10, letterSpacing:isMobile?".08em":".22em", textTransform:"uppercase", transition:"all .2s", marginBottom:-1, flex:isMobile?1:"unset", textAlign:"center" }}>
              {t.label}
            </button>
          ))}
        </div>

        {loading && <Spin label="SYNCING IMPERIAL REGISTRY…" />}

        {err && !loading && (
          <div style={{ background:"rgba(255,68,68,.06)", border:"1px solid rgba(255,68,68,.2)", borderRadius:4, padding:"14px 20px", color:"#ff4444", fontFamily:MONO, fontSize:11, marginBottom:24 }}>⚠ {err}</div>
        )}

        {/* ── LOOKUP TAB ── */}
        {!loading && tab === "lookup" && (
          <div style={{ animation:"fadeUp .4s ease" }}>
            <LookupPanel citizens={citizens} />
            {leaderboard.length > 0 && (
              <>
                <div style={{ fontFamily:ORB, fontSize:12, fontWeight:700, letterSpacing:".3em", color:"#00ffe5", marginBottom:4 }}>◈ TOP 3 CITIZENS</div>
                <Rule />
                <div style={{ display:"grid", gridTemplateColumns:isMobile?"1fr":"repeat(auto-fit,minmax(280px,1fr))", gap:12 }}>
                  {leaderboard.slice(0,3).map(c => (
                    <div key={c.username} onClick={() => setSelected(c)} style={{ cursor:"pointer" }}>
                      <ProfileCard c={c} />
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── LEADERBOARD TAB ── */}
        {!loading && tab === "leaderboard" && (
          <div style={{ animation:"fadeUp .4s ease" }}>
            <div style={{ fontFamily:ORB, fontSize:12, fontWeight:700, letterSpacing:".3em", color:"#00ffe5", marginBottom:4 }}>TOP {leaderboard.length} IMPERIAL CITIZENS</div>
            <Rule />
            <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:24 }}>
              {leaderboard.length > 0
                ? leaderboard.map((c, i) => <LeaderRow key={c.username} c={c} idx={i} onClick={() => setSelected(c)} isMobile={isMobile} />)
                : <div style={{ textAlign:"center", color:"#4a7a8a", padding:48, fontFamily:MONO, fontSize:12 }}>NO LEADERBOARD DATA — API MAY BE OFFLINE</div>
              }
            </div>
            <div style={{ background:"rgba(255,255,255,.02)", border:"1px solid rgba(255,255,255,.06)", borderRadius:4, padding:isMobile?"12px 14px":"14px 18px" }}>
              <div style={{ fontFamily:MONO, fontSize:9, letterSpacing:".3em", color:"#4a7a8a", marginBottom:10 }}>IMPERIAL TIER CLASSIFICATION</div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:isMobile?10:14 }}>
                {Object.entries(TIERS).filter(([k]) => k!=="DEFAULT").map(([name, col]) => (
                  <div key={name} style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <div style={{ width:6, height:6, borderRadius:"50%", background:col.glow, boxShadow:`0 0 5px ${col.glow}` }} />
                    <span style={{ fontSize:10, color:col.text, fontFamily:MONO, letterSpacing:".15em" }}>{name}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── REGISTRY TAB ── */}
        {!loading && tab === "registry" && (
          <div style={{ animation:"fadeUp .4s ease" }}>
            <div style={{ display:"flex", gap:isMobile?8:10, marginBottom:20, flexWrap:"wrap", alignItems:"center", flexDirection:isMobile?"column":"row" }}>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={isMobile?"SEARCH // NAME · WALLET · TIER…":"SEARCH // USERNAME · WALLET · TIER · SKILL…"}
                style={{ flex:1, minWidth:isMobile?"100%":220, background:"rgba(255,255,255,.04)", border:"1px solid rgba(0,255,229,.2)", borderRadius:4, padding:isMobile?"10px 12px":"10px 14px", color:"#e0f0ff", fontFamily:MONO, fontSize:isMobile?11:13, width:isMobile?"100%":"auto" }}
              />
              <div style={{ display:"flex", gap:8, alignItems:"center", width:isMobile?"100%":"auto", justifyContent:isMobile?"space-between":"flex-start" }}>
                <div style={{ fontFamily:ORB, fontSize:10, padding:"6px 14px", background:"rgba(0,255,229,.06)", border:"1px solid rgba(0,255,229,.2)", borderRadius:3, color:"#00ffe5", letterSpacing:".2em", whiteSpace:"nowrap" }}>
                  {filtered.length} / {citizens.length}
                </div>
                {search && <button onClick={() => setSearch("")} style={{ background:"none", border:"1px solid rgba(255,255,255,.1)", color:"#4a7a8a", padding:"6px 12px", fontFamily:MONO, fontSize:10, borderRadius:3 }}>CLEAR</button>}
              </div>
            </div>
            <div style={{ fontFamily:ORB, fontSize:12, fontWeight:700, letterSpacing:".3em", color:"#00ffe5", marginBottom:4 }}>IMPERIAL REGISTRY</div>
            <Rule />
            <div style={{ display:"grid", gridTemplateColumns:isMobile?"1fr":"repeat(auto-fill,minmax(260px,1fr))", gap:10 }}>
              {filtered.length > 0
                ? filtered.map((c, i) => <RegCard key={c.username} c={c} idx={i} onClick={() => setSelected(c)} />)
                : <div style={{ gridColumn:"1/-1", textAlign:"center", color:"#4a7a8a", padding:48, fontFamily:MONO, fontSize:12 }}>NO CITIZENS MATCH "{search}"</div>
              }
            </div>
          </div>
        )}

        {/* ── ANALYTICS TAB ── */}
        {!loading && tab === "analytics" && (
          <div style={{ animation:"fadeUp .4s ease" }}>

            {/* ─── TIER BREAKDOWN ─── */}
            <div style={{ fontFamily:ORB, fontSize:12, fontWeight:700, letterSpacing:".3em", color:"#00ffe5", marginBottom:4 }}>◆ IMPERIAL TIER BREAKDOWN</div>
            <Rule />
            <div style={{ display:"grid", gridTemplateColumns:isMobile?"1fr":"repeat(auto-fit,minmax(200px,1fr))", gap:isMobile?10:14, marginBottom:40 }}>
              {(["COSMIC","HARMONIC_MASTER","HARMONIC","ENTRAINED","INITIATE"] as const).map(tierName => {
                const t = tc(tierName);
                const meta = tierMeta[tierName];
                const count = meta?.count ?? citizens.filter(c => c.tier?.toUpperCase().replace(/\s+/g,"_") === tierName).length;
                const pct = citizens.length ? Math.round(count / citizens.length * 100) : 0;
                return (
                  <div key={tierName} style={{ background:`linear-gradient(135deg,${t.bg},rgba(255,255,255,.02))`, border:`1px solid ${t.glow}30`, borderRadius:6, padding:isMobile?"16px":"20px", position:"relative", overflow:"hidden" }}>
                    {/* Glow accent */}
                    <div style={{ position:"absolute", top:0, left:0, right:0, height:2, background:`linear-gradient(90deg,${t.glow},transparent)` }} />

                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12 }}>
                      <div>
                        <div style={{ fontFamily:ORB, fontSize:isMobile?11:13, fontWeight:900, color:t.text, letterSpacing:".08em" }}>{tierName.replace("_"," ")}</div>
                        <div style={{ fontFamily:MONO, fontSize:9, color:"#4a7a8a", marginTop:3, letterSpacing:".15em" }}>{meta?.min_score != null ? `${meta.min_score.toLocaleString()}+ PTS` : "—"}</div>
                      </div>
                      <div style={{ textAlign:"right" }}>
                        <div style={{ fontFamily:ORB, fontSize:isMobile?18:22, fontWeight:900, color:t.text }}>{count}</div>
                        <div style={{ fontFamily:MONO, fontSize:9, color:"#4a7a8a" }}>{pct}%</div>
                      </div>
                    </div>

                    {/* Distribution bar */}
                    <div style={{ height:4, background:"rgba(255,255,255,.06)", borderRadius:2, overflow:"hidden", marginBottom:12 }}>
                      <div style={{ height:"100%", width:`${pct}%`, background:t.glow, borderRadius:2, boxShadow:`0 0 8px ${t.glow}50`, transition:"width .6s ease" }} />
                    </div>

                    {/* XNT Reward */}
                    {meta?.xnt_reward != null && meta.xnt_reward > 0 && (
                      <div style={{ display:"flex", alignItems:"center", gap:6, padding:"8px 10px", background:"rgba(255,255,255,.03)", border:"1px solid rgba(255,255,255,.06)", borderRadius:3 }}>
                        <span style={{ fontFamily:MONO, fontSize:9, color:"#4a7a8a", letterSpacing:".2em" }}>REWARD</span>
                        <span style={{ fontFamily:ORB, fontSize:isMobile?12:14, fontWeight:700, color:t.text }}>{meta.xnt_reward} XNT</span>
                      </div>
                    )}
                    {meta?.xnt_reward === 0 && (
                      <div style={{ fontFamily:MONO, fontSize:9, color:"#2a3a4a", letterSpacing:".15em", padding:"8px 10px" }}>NO REWARD ALLOCATION</div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* ─── STATS & ANALYTICS ─── */}
            <div style={{ fontFamily:ORB, fontSize:12, fontWeight:700, letterSpacing:".3em", color:"#00ffe5", marginBottom:4 }}>◆ NETWORK ANALYTICS</div>
            <Rule />

            {/* Score distribution */}
            <div style={{ marginBottom:32 }}>
              <div style={{ fontFamily:MONO, fontSize:9, letterSpacing:".3em", color:"#4a7a8a", marginBottom:12 }}>SCORE DISTRIBUTION</div>
              <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                {citizens.slice(0, isMobile ? 10 : 15).map((c, i) => {
                  const maxScore = citizens[0]?.score || 1;
                  const pct = Math.max(2, (c.score / maxScore) * 100);
                  const t = tc(c.tier);
                  return (
                    <div key={c.username} style={{ display:"flex", alignItems:"center", gap:isMobile?8:12 }}>
                      <div style={{ fontFamily:MONO, fontSize:isMobile?8:9, color:"#4a7a8a", width:isMobile?20:24, textAlign:"right", flexShrink:0 }}>#{c.rank}</div>
                      <div style={{ fontFamily:ORB, fontSize:isMobile?9:10, color:"#e0f0ff", width:isMobile?80:120, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flexShrink:0 }}>{c.handle || c.username}</div>
                      <div style={{ flex:1, height:isMobile?10:12, background:"rgba(255,255,255,.04)", borderRadius:2, overflow:"hidden", position:"relative" }}>
                        <div style={{ height:"100%", width:`${pct}%`, background:`linear-gradient(90deg,${t.glow}80,${t.glow}30)`, borderRadius:2, transition:"width .5s ease", animation:`slideIn .3s ease ${i*0.03}s both` }} />
                      </div>
                      <div style={{ fontFamily:ORB, fontSize:isMobile?9:10, color:t.text, width:isMobile?45:55, textAlign:"right", flexShrink:0 }}>+{c.score.toLocaleString()}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Key metrics row */}
            <div style={{ display:"grid", gridTemplateColumns:isMobile?"1fr 1fr":"repeat(4,1fr)", gap:isMobile?8:12, marginBottom:32 }}>
              {(() => {
                const scores = citizens.map(c => c.score);
                const avg = scores.length ? Math.round(scores.reduce((a,b) => a+b, 0) / scores.length) : 0;
                const median = scores.length ? scores.sort((a,b) => a-b)[Math.floor(scores.length/2)] : 0;
                const totalContributions = citizens.reduce((s,c) => s + (c.contributions?.length ?? 0), 0);
                const verifiedPct = citizens.length ? Math.round(citizens.filter(c => c.verified).length / citizens.length * 100) : 0;
                return [
                  { label:"AVG SCORE", value:`+${avg.toLocaleString()}`, color:"#00ffe5" },
                  { label:"MEDIAN SCORE", value:`+${median.toLocaleString()}`, color:"#00ffe5" },
                  { label:"TOTAL CONTRIBUTIONS", value:String(totalContributions), color:"#ffd700" },
                  { label:"VERIFIED RATE", value:`${verifiedPct}%`, color:verifiedPct >= 75 ? "#00ffe5" : "#ff6b35" },
                ];
              })().map(s => <Stat key={s.label} label={s.label} value={s.value} color={s.color} />)}
            </div>

            {/* Top Contributors */}
            <div style={{ marginBottom:32 }}>
              <div style={{ fontFamily:MONO, fontSize:9, letterSpacing:".3em", color:"#4a7a8a", marginBottom:12 }}>TOP CONTRIBUTORS BY SUBMISSIONS</div>
              <div style={{ display:"grid", gridTemplateColumns:isMobile?"1fr":"1fr 1fr", gap:8 }}>
                {[...citizens].sort((a,b) => (b.contributions?.length ?? 0) - (a.contributions?.length ?? 0)).slice(0, 6).map((c, i) => {
                  const t = tc(c.tier);
                  return (
                    <div key={c.username} onClick={() => setSelected(c)} style={{ display:"flex", alignItems:"center", gap:isMobile?10:14, padding:isMobile?"12px":"14px 18px", background:"rgba(255,255,255,.02)", border:"1px solid rgba(255,255,255,.06)", borderRadius:4, cursor:"pointer", transition:"all .2s" }}
                      onMouseEnter={e => { e.currentTarget.style.background = "rgba(0,255,229,.05)"; e.currentTarget.style.borderColor = t.glow + "40"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,.02)"; e.currentTarget.style.borderColor = "rgba(255,255,255,.06)"; }}
                    >
                      <div style={{ fontFamily:ORB, fontSize:isMobile?14:16, fontWeight:700, color:i<3?"#ffd700":"#4a7a8a", width:28, textAlign:"center", flexShrink:0 }}>{medal(i+1)}</div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontFamily:ORB, fontSize:isMobile?10:12, fontWeight:700, color:"#e0f0ff", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.handle || c.username}</div>
                        <div style={{ fontFamily:MONO, fontSize:9, color:"#4a7a8a", marginTop:2 }}>{c.contributions?.length ?? 0} contributions · +{c.contributions?.reduce((s,ct) => s + ct.points, 0) ?? 0} pts</div>
                      </div>
                      <Badge tier={c.tier} />
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ─── CONTRIBUTION TIMELINE ─── */}
            <div style={{ fontFamily:ORB, fontSize:12, fontWeight:700, letterSpacing:".3em", color:"#00ffe5", marginBottom:4 }}>◆ CONTRIBUTION TIMELINE</div>
            <Rule />
            <div style={{ position:"relative", paddingLeft:isMobile?20:32 }}>
              {/* Timeline line */}
              <div style={{ position:"absolute", left:isMobile?8:14, top:0, bottom:0, width:2, background:"linear-gradient(180deg,#00ffe530,#00ffe508)" }} />

              {(() => {
                // Gather all contributions with citizen info, sort by date desc
                const allContribs = citizens.flatMap(c =>
                  (c.contributions ?? []).map(ct => ({ ...ct, citizen: c }))
                ).sort((a, b) => {
                  if (!a.date && !b.date) return 0;
                  if (!a.date) return 1;
                  if (!b.date) return -1;
                  return b.date.localeCompare(a.date);
                }).slice(0, isMobile ? 15 : 25);

                // Group by date
                const grouped: Record<string, typeof allContribs> = {};
                allContribs.forEach(ct => {
                  const key = ct.date || "Unknown Date";
                  if (!grouped[key]) grouped[key] = [];
                  grouped[key].push(ct);
                });

                return Object.entries(grouped).map(([date, items], gi) => (
                  <div key={date} style={{ marginBottom:24, animation:`fadeUp .3s ease ${gi*0.05}s both` }}>
                    {/* Date node */}
                    <div style={{ display:"flex", alignItems:"center", gap:isMobile?10:14, marginBottom:10, position:"relative" }}>
                      <div style={{ position:"absolute", left:isMobile?-16:-24, width:10, height:10, borderRadius:"50%", background:"#00ffe5", boxShadow:"0 0 8px #00ffe550", border:"2px solid #050a0e" }} />
                      <div style={{ fontFamily:ORB, fontSize:isMobile?10:11, fontWeight:700, color:"#00ffe5", letterSpacing:".15em" }}>
                        {date === "Unknown Date" ? "DATE PENDING" : new Date(date + "T00:00:00").toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" })}
                      </div>
                      <div style={{ fontFamily:MONO, fontSize:9, color:"#2a4a5a" }}>{items.length} {items.length===1?"entry":"entries"}</div>
                    </div>

                    {/* Entries for this date */}
                    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                      {items.map((ct, ci) => {
                        const t = tc(ct.citizen.tier);
                        return (
                          <div key={ci} onClick={() => setSelected(ct.citizen)} style={{ display:"flex", alignItems:isMobile?"flex-start":"center", flexDirection:isMobile?"column":"row", gap:isMobile?6:0, justifyContent:"space-between", padding:isMobile?"10px 12px":"10px 16px", background:"rgba(255,255,255,.02)", border:"1px solid rgba(255,255,255,.05)", borderRadius:4, cursor:"pointer", transition:"all .15s" }}
                            onMouseEnter={e => { e.currentTarget.style.background = "rgba(0,255,229,.04)"; }}
                            onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,.02)"; }}
                          >
                            <div style={{ flex:1, minWidth:0 }}>
                              <div style={{ fontFamily:MONO, fontSize:isMobile?10:11, color:"#e0f0ff" }}>▸ {ct.item}</div>
                              <div style={{ display:"flex", gap:8, alignItems:"center", marginTop:4, flexWrap:"wrap" }}>
                                <span style={{ fontFamily:ORB, fontSize:9, color:t.text }}>{ct.citizen.handle || ct.citizen.username}</span>
                                <Badge tier={ct.citizen.tier} />
                              </div>
                            </div>
                            <div style={{ fontFamily:ORB, fontSize:isMobile?12:13, fontWeight:700, color:t.text, flexShrink:0, marginLeft:isMobile?0:16 }}>+{ct.points}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ));
              })()}

              {citizens.flatMap(c => c.contributions ?? []).length === 0 && (
                <div style={{ textAlign:"center", color:"#4a7a8a", padding:48, fontFamily:MONO, fontSize:12 }}>NO CONTRIBUTION DATA AVAILABLE</div>
              )}
            </div>

          </div>
        )}
      </div>

      {/* ── MODAL ── */}
      {selected && (
        <div onClick={() => setSelected(null)} style={{ position:"fixed", inset:0, background:"rgba(0,5,10,.92)", backdropFilter:"blur(8px)", zIndex:200, display:"flex", alignItems:isMobile?"flex-start":"center", justifyContent:"center", padding:isMobile?"16px 10px":"20px", overflowY:"auto" }}>
          <div onClick={e => e.stopPropagation()} style={{ maxWidth:640, width:"100%", maxHeight:isMobile?"none":"90vh", overflowY:isMobile?"visible":"auto", marginTop:isMobile?12:0, marginBottom:isMobile?40:0 }}>
            <ProfileCard c={selected} onClose={() => setSelected(null)} isMobile={isMobile} />
          </div>
        </div>
      )}
    </div>
  );
}
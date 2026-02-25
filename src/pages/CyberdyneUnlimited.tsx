// src/pages/CyberdyneUnlimited.tsx
// ─────────────────────────────────────────────────────────────────────────────
// CYBERDYNE UNLIMITED — Imperial Citizen Registry
// Lookup by username OR X1 wallet address. All data fetched live from API.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from "react";

// ─── DATA SOURCE — GitHub Gist JSON ──────────────────────────────────────────
// jacklevin74 regenerates the JSON and pushes to this Gist whenever scores update.
// Full registry — all citizens:
const GIST_ALL = "https://gist.githubusercontent.com/jacklevin74/d4c429c3d31e190247fd79b00d92f350/raw/cyberdyne.json";

// Cache-bust: append timestamp so GitHub CDN doesn't serve stale
const fetchJSON = (url: string) =>
  fetch(`${url}?t=${Date.now()}`, { headers: { Accept: "application/json" } });

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface Citizen {
  username:         string;
  wallet:           string | null;
  score:            number;
  tier:             string;
  rank:             number;
  skills:           string[];
  passport_active:  boolean;
  passport_status?: boolean;
  telegram_id?:     number | null;
  projects?:        any[];
  last_updated?:    string;
}

interface ApiHealth {
  status:          string;
  citizens_count:  number;
  version?:        string;
  timestamp?:      string;
}

// ─── TIER STYLES ─────────────────────────────────────────────────────────────
const TIERS: Record<string, { glow: string; bg: string; text: string }> = {
  HARMONIC:  { glow: "#00ffe5", bg: "rgba(0,255,229,.10)",   text: "#00ffe5" },
  MECHANIC:  { glow: "#00ffe5", bg: "rgba(0,255,229,.10)",   text: "#00ffe5" },
  SOVEREIGN: { glow: "#ffd700", bg: "rgba(255,215,0,.10)",   text: "#ffd700" },
  SENTINEL:  { glow: "#ff6b35", bg: "rgba(255,107,53,.10)",  text: "#ff6b35" },
  INITIATE:  { glow: "#a78bfa", bg: "rgba(167,139,250,.10)", text: "#a78bfa" },
  DEFAULT:   { glow: "#4ade80", bg: "rgba(74,222,128,.10)",  text: "#4ade80" },
};
const tc        = (tier = "") => { const k = Object.keys(TIERS).find(k => tier.toUpperCase().includes(k)); return k ? TIERS[k] : TIERS.DEFAULT; };
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

const Stat = ({ label, value, sub, color="#e0f0ff", dot }: { label:string; value:string; sub?:string; color?:string; dot?:boolean }) => (
  <div style={{ background:"rgba(255,255,255,.03)", border:"1px solid rgba(255,255,255,.07)", borderRadius:4, padding:"12px 16px" }}>
    <div style={{ fontSize:9, letterSpacing:".3em", color:"#4a7a8a", textTransform:"uppercase", marginBottom:6, fontFamily:MONO }}>{label}</div>
    <div style={{ display:"flex", alignItems:"center", gap:7 }}>
      {dot !== undefined && <div style={{ width:7, height:7, borderRadius:"50%", flexShrink:0, background:dot?"#00ffe5":"#333", boxShadow:dot?"0 0 6px #00ffe5":"none" }} />}
      <span style={{ fontFamily:ORB, fontSize:16, fontWeight:700, color }}>{value}</span>
    </div>
    {sub && <div style={{ fontSize:9, color:"#4a7a8a", marginTop:4, fontFamily:MONO }}>{sub}</div>}
  </div>
);

// ─── CITIZEN PROFILE CARD ─────────────────────────────────────────────────────
function ProfileCard({ c, onClose }: { c: Citizen; onClose?: () => void }) {
  const t       = tc(c.tier);
  const passport = c.passport_status ?? c.passport_active ?? false;

  return (
    <div style={{ background:"#070f15", border:`1px solid ${t.glow}30`, borderRadius:8, overflow:"hidden", boxShadow:`0 0 40px ${t.glow}08`, animation:"fadeUp .3s ease" }}>
      {/* ── Header ── */}
      <div style={{ padding:"24px 28px 18px", background:`linear-gradient(135deg,${t.bg},transparent)`, borderBottom:`1px solid ${t.glow}15` }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
          <div style={{ minWidth:0 }}>
            <Badge tier={c.tier} />
            <div style={{ fontFamily:ORB, fontSize:22, fontWeight:900, color:"#e0f0ff", letterSpacing:".06em", margin:"10px 0 4px" }}>{c.username}</div>
            <div style={{ fontFamily:MONO, fontSize:10, color:"#4a7a8a", wordBreak:"break-all" }}>{c.wallet || "No wallet on file"}</div>
          </div>
          <div style={{ textAlign:"right", flexShrink:0, marginLeft:16 }}>
            <div style={{ fontFamily:ORB, fontSize:28, fontWeight:900, color:c.rank<=3?"#ffd700":"#4a7a8a" }}>{medal(c.rank)}</div>
            <div style={{ fontFamily:MONO, fontSize:9, color:"#4a7a8a", marginTop:2 }}>RANK #{c.rank}</div>
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ padding:"20px 28px" }}>
        {/* Stats */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))", gap:10, marginBottom:20 }}>
          <Stat label="Score"    value={`+${c.score?.toLocaleString()}`}       color={t.text} />
          <Stat label="Rank"     value={`#${c.rank}`}                           color={t.text} />
          <Stat label="Passport" value={passport?"ACTIVE":"INACTIVE"}           color={passport?"#00ffe5":"#555"} dot={passport} />
          {c.last_updated && (
            <Stat label="Last Updated" value={c.last_updated.slice(0,10)} sub={c.last_updated.slice(11,19)+" UTC"} color="#8aabbc" />
          )}
        </div>

        {/* Skills */}
        {!!c.skills?.length && (
          <div style={{ marginBottom:16 }}>
            <div style={{ fontFamily:MONO, fontSize:9, letterSpacing:".3em", color:"#4a7a8a", marginBottom:8 }}>SKILL MODULES ({c.skills.length})</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
              {c.skills.map(s => <Pill key={s} label={s} color={t.text} />)}
            </div>
          </div>
        )}

        {/* Projects */}
        {!!c.projects?.length && (
          <div style={{ marginBottom:16 }}>
            <div style={{ fontFamily:MONO, fontSize:9, letterSpacing:".3em", color:"#4a7a8a", marginBottom:8 }}>PROJECTS LOGGED ({c.projects.length})</div>
            <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
              {c.projects.map((p, i) => (
                <div key={i} style={{ fontSize:11, padding:"6px 12px", background:"rgba(255,255,255,.03)", border:"1px solid rgba(255,255,255,.06)", borderRadius:3, color:"#8aabbc", fontFamily:MONO }}>
                  ▸ {typeof p === "string" ? p : JSON.stringify(p)}
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
        <div style={{ display:"flex", gap:8 }}>
          <input
            value={query}
            onChange={e => { setQuery(e.target.value); setResult(null); setErr(""); setShowDrop(true); }}
            onKeyDown={e => { if (e.key === "Enter") lookup(query); if (e.key === "Escape") setShowDrop(false); }}
            onFocus={() => setShowDrop(true)}
            placeholder="Username  or  X1 wallet address…"
            style={{ flex:1, background:"rgba(255,255,255,.04)", border:"1px solid rgba(0,255,229,.25)", borderRadius:4, padding:"13px 16px", color:"#e0f0ff", fontFamily:MONO, fontSize:13 }}
          />
          <button
            onClick={() => lookup(query)}
            disabled={loading || !query.trim()}
            style={{ background:"rgba(0,255,229,.1)", border:"1px solid rgba(0,255,229,.3)", color:"#00ffe5", padding:"13px 24px", fontFamily:MONO, fontSize:11, letterSpacing:".2em", borderRadius:4, flexShrink:0, opacity:(!query.trim()||loading)?0.4:1 }}
          >
            {loading ? "…" : "SEARCH"}
          </button>
        </div>

        {/* Autocomplete */}
        {showDrop && suggestions.length > 0 && !result && (
          <div style={{ position:"absolute", top:"calc(100% + 4px)", left:0, right:90, zIndex:50, background:"#070f15", border:"1px solid rgba(0,255,229,.2)", borderRadius:4, overflow:"hidden", boxShadow:"0 8px 32px rgba(0,0,0,.5)" }}>
            {suggestions.map(c => (
              <div
                key={c.username}
                onClick={() => { setQuery(c.username); lookup(c.username); }}
                style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 14px", cursor:"pointer", borderBottom:"1px solid rgba(255,255,255,.04)", transition:"background .15s" }}
                onMouseEnter={e => (e.currentTarget.style.background="rgba(0,255,229,.07)")}
                onMouseLeave={e => (e.currentTarget.style.background="transparent")}
              >
                <div>
                  <span style={{ fontFamily:ORB, fontSize:12, color:"#e0f0ff" }}>{c.username}</span>
                  <span style={{ fontFamily:MONO, fontSize:9, color:"#4a7a8a", marginLeft:10 }}>{sw(c.wallet ?? "")}</span>
                </div>
                <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                  <Badge tier={c.tier} />
                  <span style={{ fontFamily:ORB, fontSize:11, color:tc(c.tier).text }}>+{c.score}</span>
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
function LeaderRow({ c, onClick, idx }: { c: Citizen; onClick: () => void; idx: number }) {
  const [hov, setHov] = useState(false);
  const t = tc(c.tier);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display:"grid", gridTemplateColumns:"52px 1fr auto 90px", alignItems:"center", gap:14,
        padding:"13px 18px", borderRadius:4, cursor:"pointer", transition:"all .2s",
        background:hov?"rgba(0,255,229,.06)":c.rank<=3?"rgba(0,255,229,.03)":"rgba(255,255,255,.02)",
        border:`1px solid ${hov?t.glow:c.rank<=3?"rgba(0,255,229,.18)":"rgba(255,255,255,.06)"}`,
        boxShadow:hov?`0 0 20px ${t.glow}15`:"none",
        animation:`slideIn .3s ease ${Math.min(idx*0.04,0.5)}s both`,
      }}
    >
      <div style={{ fontFamily:ORB, fontSize:c.rank<=3?20:12, fontWeight:700, textAlign:"center", color:c.rank===1?"#ffd700":c.rank===2?"#c0c0c0":c.rank===3?"#cd7f32":"#4a7a8a" }}>
        {medal(c.rank)}
      </div>
      <div>
        <div style={{ fontFamily:ORB, fontSize:13, fontWeight:700, color:"#e0f0ff", letterSpacing:".04em" }}>{c.username}</div>
        <div style={{ display:"flex", gap:5, marginTop:4, flexWrap:"wrap", alignItems:"center" }}>
          {c.skills?.slice(0,3).map(s => <Pill key={s} label={s} color={t.text} />)}
          <span style={{ display:"inline-flex", alignItems:"center", gap:4 }}>
            <span style={{ width:5, height:5, borderRadius:"50%", background:(c.passport_active||c.passport_status)?"#00ffe5":"#2a3a4a", boxShadow:(c.passport_active||c.passport_status)?"0 0 5px #00ffe5":"none", display:"inline-block" }} />
            <span style={{ fontSize:9, color:"#3a6a7a", letterSpacing:".12em", fontFamily:MONO }}>PASSPORT</span>
          </span>
        </div>
      </div>
      <div style={{ textAlign:"right" }}>
        <Badge tier={c.tier} />
        <div style={{ fontSize:9, color:"#4a7a8a", marginTop:4, fontFamily:MONO }}>{sw(c.wallet ?? "")}</div>
      </div>
      <div style={{ fontFamily:ORB, fontSize:15, fontWeight:900, color:t.text, textAlign:"right", textShadow:`0 0 10px ${t.glow}70` }}>
        +{c.score.toLocaleString()}
      </div>
    </div>
  );
}

// ─── REGISTRY CARD ────────────────────────────────────────────────────────────
function RegCard({ c, onClick, idx }: { c: Citizen; onClick: () => void; idx: number }) {
  const [hov, setHov] = useState(false);
  const t = tc(c.tier);
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
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:9 }}>
        <div style={{ minWidth:0 }}>
          <div style={{ fontFamily:ORB, fontSize:12, fontWeight:700, color:"#e0f0ff", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.username}</div>
          <div style={{ fontSize:9, color:"#4a7a8a", fontFamily:MONO, marginTop:2 }}>{sw(c.wallet ?? "")}</div>
        </div>
        <span style={{ fontFamily:ORB, fontSize:12, fontWeight:700, color:c.rank<=3?"#ffd700":"#4a7a8a", flexShrink:0, marginLeft:8 }}>{medal(c.rank)}</span>
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <Badge tier={c.tier} />
        <span style={{ fontFamily:ORB, fontWeight:700, color:t.text, fontSize:13 }}>+{c.score.toLocaleString()}</span>
      </div>
      {!!c.skills?.length && (
        <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginTop:9 }}>
          {c.skills.slice(0,3).map(s => <Pill key={s} label={s} color={t.text} />)}
          {c.skills.length > 3 && <span style={{ fontSize:9, color:"#4a7a8a", fontFamily:MONO }}>+{c.skills.length-3}</span>}
        </div>
      )}
    </div>
  );
}

// ─── STATS BAR ────────────────────────────────────────────────────────────────
function StatsBar({ citizens, health }: { citizens: Citizen[]; health: ApiHealth | null }) {
  if (!citizens.length) return null;
  const passports  = citizens.filter(c => c.passport_active || c.passport_status).length;
  const totalScore = citizens.reduce((s, c) => s + (c.score || 0), 0);
  const tierMap: Record<string, number> = {};
  citizens.forEach(c => { const t = cleanTier(c.tier)||"UNKNOWN"; tierMap[t] = (tierMap[t]??0)+1; });
  const topTier = Object.entries(tierMap).sort((a,b)=>b[1]-a[1])[0];
  return (
    <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))", gap:10, marginBottom:32 }}>
      <Stat label="Total Citizens"   value={String(health?.citizens_count ?? citizens.length)} color="#00ffe5" />
      <Stat label="Passports Active" value={String(passports)} sub={`${Math.round(passports/citizens.length*100)}% of registry`} color="#00ffe5" />
      <Stat label="Total Score Pool" value={`+${totalScore.toLocaleString()}`} color="#ffd700" />
      <Stat label="Top Tier"         value={topTier?.[0]??"—"} sub={`${topTier?.[1]??0} citizens`} color="#00ffe5" />
      <Stat label="Data Source"       value={health?.status==="healthy"?"SYNCED":"OFFLINE"} sub={health?.timestamp ? `Updated ${new Date(health.timestamp).toLocaleString()}` : undefined} color={health?.status==="healthy"?"#00ffe5":"#ff4444"} dot={health?.status==="healthy"} />
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
export default function CyberdyneUnlimited() {
  const [citizens,    setCitizens]    = useState<Citizen[]>([]);
  const [leaderboard, setLeaderboard] = useState<Citizen[]>([]);
  const [filtered,    setFiltered]    = useState<Citizen[]>([]);
  const [health,      setHealth]      = useState<ApiHealth | null>(null);
  const [search,      setSearch]      = useState("");
  const [selected,    setSelected]    = useState<Citizen | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [err,         setErr]         = useState("");
  const [apiAlive,    setApiAlive]    = useState<boolean | null>(null);
  const [tab,         setTab]         = useState<"lookup"|"leaderboard"|"registry">("lookup");

  const fetchAll = useCallback(async () => {
    setLoading(true); setErr("");

    try {
      const r = await fetchJSON(GIST_ALL);
      if (!r.ok) throw new Error(`Gist fetch failed: HTTP ${r.status}`);
      const data = await r.json();

      // Parse citizens array — handle jacklevin's format: { citizens, meta, tiers }
      const all: Citizen[] = Array.isArray(data) ? data
        : Array.isArray(data.citizens) ? data.citizens
        : Array.isArray(data.leaderboard) ? data.leaderboard
        : [];

      if (all.length === 0) throw new Error("No citizens found in JSON");

      // Assign ranks if not present (sort by score desc)
      const sorted = [...all].sort((a, b) => (b.score || 0) - (a.score || 0));
      sorted.forEach((c, i) => { if (!c.rank) c.rank = i + 1; });

      setCitizens(sorted);
      setFiltered(sorted);
      setLeaderboard(sorted.slice(0, 25));

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
      (c.wallet ?? "").toLowerCase().includes(q) ||
      c.tier.toLowerCase().includes(q) ||
      c.skills?.some(s => s.toLowerCase().includes(q))
    ));
  }, [search, citizens]);

  const TABS = [
    { key:"lookup",      label:"◎ LOOKUP" },
    { key:"leaderboard", label:"◈ LEADERBOARD" },
    { key:"registry",    label:"◉ REGISTRY" },
  ] as const;

  return (
    <div style={{ minHeight:"100vh", background:"#050a0e", fontFamily:MONO, color:"#c8d8e8", position:"relative", overflow:"hidden" }}>
      <style>{KF}</style>

      {/* Grid */}
      <div style={{ position:"fixed", inset:0, backgroundImage:"linear-gradient(rgba(0,255,229,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,229,.025) 1px,transparent 1px)", backgroundSize:"40px 40px", pointerEvents:"none", zIndex:0 }} />
      {/* Scanline */}
      <div style={{ position:"fixed", top:0, left:0, right:0, height:2, background:"rgba(0,255,229,.08)", animation:"scan 8s linear infinite", pointerEvents:"none", zIndex:1 }} />

      <div style={{ position:"relative", zIndex:2, maxWidth:1200, margin:"0 auto", padding:"36px 24px 80px" }}>

        {/* ── HEADER ── */}
        <header style={{ textAlign:"center", marginBottom:40, animation:"fadeUp .5s ease" }}>
          <div style={{ fontFamily:ORB, fontSize:"clamp(22px,5vw,48px)", fontWeight:900, letterSpacing:".1em", lineHeight:1.1, marginBottom:8, background:"linear-gradient(135deg,#00ffe5,#0077ff,#00ffe5)", backgroundSize:"200% 200%", animation:"shimmer 4s ease infinite", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", backgroundClip:"text" }}>
            CYBERDYNE UNLIMITED
          </div>
          <div style={{ fontSize:10, letterSpacing:".35em", color:"#004455", textTransform:"uppercase", marginBottom:18, fontFamily:MONO }}>
            Imperial Citizen Registry // Live Neural Uplink
          </div>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:18, flexWrap:"wrap", fontSize:11, color:"#4a7a8a", letterSpacing:".1em" }}>
            <span style={{ display:"inline-flex", alignItems:"center", gap:6 }}>
              <span style={{ width:8, height:8, borderRadius:"50%", display:"inline-block", background:apiAlive===null?"#888":apiAlive?"#00ffe5":"#ff4444", boxShadow:apiAlive?"0 0 8px #00ffe5":apiAlive===false?"0 0 8px #ff4444":"none", animation:apiAlive?"pulse 2s ease infinite":"none" }} />
              {apiAlive===null?"PINGING…":apiAlive?"API ONLINE":"API OFFLINE"}
            </span>
            <span style={{ color:"#1a3040" }}>|</span>
            {/* ✅ FIX: wrapped (citizens.length || "…") in parens to avoid ?? + || mixing error */}
            <span>CITIZENS: <span style={{ color:"#00ffe5" }}>{health?.citizens_count ?? (citizens.length || "…")}</span></span>
            <span style={{ color:"#1a3040" }}>|</span>
            <span>LIVE // GITHUB DATA</span>
            <button onClick={fetchAll} style={{ background:"none", border:"1px solid rgba(0,255,229,.2)", color:"#00ffe5", padding:"4px 14px", fontFamily:MONO, fontSize:10, letterSpacing:".2em", borderRadius:2 }}>↺ REFRESH</button>
          </div>
        </header>

        {/* ── STATS BAR ── */}
        {!loading && <StatsBar citizens={citizens} health={health} />}

        {/* ── TABS ── */}
        <div style={{ display:"flex", marginBottom:28, borderBottom:"1px solid rgba(0,255,229,.1)" }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{ background:"none", border:"none", borderBottom:tab===t.key?"2px solid #00ffe5":"2px solid transparent", color:tab===t.key?"#00ffe5":"#4a7a8a", padding:"10px 22px", fontFamily:ORB, fontSize:10, letterSpacing:".22em", textTransform:"uppercase", transition:"all .2s", marginBottom:-1 }}>
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
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))", gap:12 }}>
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
                ? leaderboard.map((c, i) => <LeaderRow key={c.username} c={c} idx={i} onClick={() => setSelected(c)} />)
                : <div style={{ textAlign:"center", color:"#4a7a8a", padding:48, fontFamily:MONO, fontSize:12 }}>NO LEADERBOARD DATA — API MAY BE OFFLINE</div>
              }
            </div>
            <div style={{ background:"rgba(255,255,255,.02)", border:"1px solid rgba(255,255,255,.06)", borderRadius:4, padding:"14px 18px" }}>
              <div style={{ fontFamily:MONO, fontSize:9, letterSpacing:".3em", color:"#4a7a8a", marginBottom:10 }}>IMPERIAL TIER CLASSIFICATION</div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:14 }}>
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
            <div style={{ display:"flex", gap:10, marginBottom:20, flexWrap:"wrap", alignItems:"center" }}>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="SEARCH // USERNAME · WALLET · TIER · SKILL…"
                style={{ flex:1, minWidth:220, background:"rgba(255,255,255,.04)", border:"1px solid rgba(0,255,229,.2)", borderRadius:4, padding:"10px 14px", color:"#e0f0ff", fontFamily:MONO, fontSize:13 }}
              />
              <div style={{ fontFamily:ORB, fontSize:10, padding:"6px 14px", background:"rgba(0,255,229,.06)", border:"1px solid rgba(0,255,229,.2)", borderRadius:3, color:"#00ffe5", letterSpacing:".2em", whiteSpace:"nowrap" }}>
                {filtered.length} / {citizens.length}
              </div>
              {search && <button onClick={() => setSearch("")} style={{ background:"none", border:"1px solid rgba(255,255,255,.1)", color:"#4a7a8a", padding:"6px 12px", fontFamily:MONO, fontSize:10, borderRadius:3 }}>CLEAR</button>}
            </div>
            <div style={{ fontFamily:ORB, fontSize:12, fontWeight:700, letterSpacing:".3em", color:"#00ffe5", marginBottom:4 }}>IMPERIAL REGISTRY</div>
            <Rule />
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))", gap:10 }}>
              {filtered.length > 0
                ? filtered.map((c, i) => <RegCard key={c.username} c={c} idx={i} onClick={() => setSelected(c)} />)
                : <div style={{ gridColumn:"1/-1", textAlign:"center", color:"#4a7a8a", padding:48, fontFamily:MONO, fontSize:12 }}>NO CITIZENS MATCH "{search}"</div>
              }
            </div>
          </div>
        )}
      </div>

      {/* ── MODAL ── */}
      {selected && (
        <div onClick={() => setSelected(null)} style={{ position:"fixed", inset:0, background:"rgba(0,5,10,.92)", backdropFilter:"blur(8px)", zIndex:200, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
          <div onClick={e => e.stopPropagation()} style={{ maxWidth:640, width:"100%", maxHeight:"90vh", overflowY:"auto" }}>
            <ProfileCard c={selected} onClose={() => setSelected(null)} />
          </div>
        </div>
      )}
    </div>
  );
}
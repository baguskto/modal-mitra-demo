import type { FlowStep } from "./types";
import { useReducedMotion } from "./useReducedMotion";

const NODE_R = 30;
const GAP = 160;

export function FlowDiagram({ steps }: { steps: FlowStep[] }) {
  const reduced = useReducedMotion();
  const w = steps.length * GAP;
  const cy = 46;
  const highlightIdx = Math.max(0, steps.findIndex((s) => s.highlight));

  return (
    <div className="flow-diagram">
      <svg viewBox={`0 0 ${w} 92`} className="flow-svg" role="img" aria-label="Diagram alur">
        {steps.slice(0, -1).map((s, i) => (
          <line
            key={`l${i}`}
            x1={i * GAP + NODE_R + 10}
            y1={cy}
            x2={(i + 1) * GAP + 10}
            y2={cy}
            className={`flow-line ${s.proposed || steps[i + 1]?.proposed ? "proposed" : ""}`}
          />
        ))}
        {steps.map((s, i) => (
          <g key={i} className={`flow-node ${s.blocked ? "blocked" : ""} ${s.proposed ? "proposed" : ""} ${!reduced ? "pulse" : ""}`}
             style={!reduced ? { animationDelay: `${i * 0.5}s` } : undefined}>
            <circle cx={i * GAP + NODE_R + 10} cy={cy} r={NODE_R} />
            <text x={i * GAP + NODE_R + 10} y={cy + 5} textAnchor="middle" className="flow-node-num">{i + 1}</text>
          </g>
        ))}
        {!reduced && (
          <circle r={7} className="flow-packet">
            <animateMotion
              dur={`${steps.length * 1.3}s`}
              repeatCount="indefinite"
              keyPoints={steps.map((_, i) => (i / (steps.length - 1 || 1)).toFixed(3)).join(";")}
              keyTimes={steps.map((_, i) => (i / (steps.length - 1 || 1)).toFixed(3)).join(";")}
              path={`M ${NODE_R + 10} ${cy} ${steps.slice(1).map((_, i) => `L ${(i + 1) * GAP + NODE_R + 10} ${cy}`).join(" ")}`}
            />
          </circle>
        )}
      </svg>
      <div className="flow-labels" style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }}>
        {steps.map((s, i) => (
          <div key={i} className={`flow-label ${s.highlight ? "is-highlight" : ""} ${reduced && i === highlightIdx ? "is-highlight" : ""}`}>
            <b>{s.label}</b>
            {s.sub && <span>{s.sub}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

const CASTLE_LAYERS = [
  { label: "Rate limit publik", detail: "40 req/10mnt per-IP · anomaly per-tool" },
  { label: "Heuristik + Llama Guard", detail: "2 lapis deteksi prompt injection", stop: true },
  { label: "PII vault & spotlighting", detail: "redaksi sebelum LLM lihat apa pun" },
  { label: "Guard_out", detail: "sitasi wajib · groundedness · privasi antar-majelis" },
  { label: "Least-privilege tools", detail: "0 tool bisa UPDATE/DELETE ledger inti" },
  { label: "Kill-switch per tool", detail: "matikan tool tanpa redeploy" },
  { label: "Audit hash-chain + HMAC", detail: "ketahuan kalau ada baris ditamper" },
];

export function CastleDiagram() {
  const reduced = useReducedMotion();
  const stopIdx = CASTLE_LAYERS.findIndex((l) => l.stop);
  return (
    <div className="castle-diagram">
      <div className={`castle-attacker ${reduced ? "static" : "moving"}`} style={{ "--stop-row": stopIdx } as any}>
        👾
      </div>
      <div className="castle-layers">
        {CASTLE_LAYERS.map((l, i) => (
          <div key={i} className={`castle-layer ${i === stopIdx ? "stop" : ""}`}>
            <span className="castle-layer-idx">{i + 1}</span>
            <div className="castle-layer-text">
              <b>{l.label}</b>
              <span>{l.detail}</span>
            </div>
            {i === stopIdx && <span className="castle-badge">💥 diblokir di sini</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function MapDiagram() {
  const steps: FlowStep[] = [
    { label: "guard_in", sub: "injeksi+PII" },
    { label: "verify_identity", sub: "2 faktor" },
    { label: "route_intent", sub: "intent+HITL" },
    { label: "tools", sub: "RAG+ReAct" },
    { label: "guard_out", sub: "sitasi+privasi" },
    { label: "respond", sub: "ke user" },
  ];
  return (
    <div className="map-diagram">
      <FlowDiagram steps={steps} />
      <div className="map-shield">🛡️ setiap node ditutupi guard + audit hash-chain + Langfuse trace</div>
    </div>
  );
}

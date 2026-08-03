import React, { useEffect, useState } from "react";
import Calendar from "./calendar/DayPlanner.tsx";
import Relationships from "./relationships/Relationships.tsx";
import ContactDetail from "./relationships/ContactDetail.tsx";
import Inbox from "./inbox/Stub.tsx";
import Settings from "./settings/Settings.tsx";

// Hash router: #/calendar · #/relationships[/contacts] · #/contact/:id · #/messaging · #/settings
export function useRoute(): string {
  const [route, setRoute] = useState(window.location.hash || "#/calendar");
  useEffect(() => {
    const fn = () => setRoute(window.location.hash || "#/calendar");
    window.addEventListener("hashchange", fn);
    return () => window.removeEventListener("hashchange", fn);
  }, []);
  return route;
}

const ICONS = {
  calendar: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 9h18M8 3v4M16 3v4" />
    </svg>
  ),
  relationships: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M2.8 19c.8-3 3.2-4.6 6.2-4.6s5.4 1.6 6.2 4.6" />
      <circle cx="17.5" cy="9.5" r="2.4" />
      <path d="M15.6 14.6c2.6.1 4.6 1.5 5.4 4" />
    </svg>
  ),
  messaging: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a8 8 0 0 1-8 8H6l-3 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" />
      <path d="M8.5 11.5h.01M12.5 11.5h.01M16.5 11.5h.01" />
    </svg>
  ),
  settings: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" />
    </svg>
  ),
};

// Bottom dock: three icons on a gentle arc (sides raised), settings gear pinned bottom-left.
const DOCK: { href: string; icon: keyof typeof ICONS; label: string; lift: number }[] = [
  { href: "#/calendar", icon: "calendar", label: "Calendar", lift: -10 },
  { href: "#/relationships", icon: "relationships", label: "Relationships", lift: 0 },
  { href: "#/messaging", icon: "messaging", label: "Messaging", lift: -10 },
];

// Falling watercolor petals, diagonal from the top right (deterministic spread).
function Petals() {
  const petals = Array.from({ length: 12 }, (_, i) => ({
    right: `${(i * 7.3) % 34}vw`,
    delay: `${(i * 1.7) % 14}s`,
    dur: `${11 + (i % 5) * 2.4}s`,
    size: `${9 + (i % 4) * 3}px`,
    drift: `${18 + (i % 6) * 5}vw`,
    spin: `${220 + (i % 5) * 60}deg`,
    op: 0.45 + (i % 4) * 0.12,
  }));
  return (
    <>
      {petals.map((p, i) => (
        <span key={i} className="petal" style={{
          right: p.right,
          ["--delay" as never]: p.delay, ["--dur" as never]: p.dur, ["--size" as never]: p.size,
          ["--drift" as never]: p.drift, ["--spin" as never]: p.spin, ["--petal-opacity" as never]: p.op,
        }} />
      ))}
    </>
  );
}

// Translucent ink branch (top-left) that grows blossoms as the app is used.
const BLOSSOM_SPOTS: [number, number][] = [
  [178, 46], [225, 30], [262, 52], [214, 78], [300, 40], [338, 66], [286, 92],
  [372, 34], [408, 58], [352, 108], [432, 90], [462, 44], [488, 72], [520, 56],
  [148, 70], [246, 112], [316, 128], [396, 122], [452, 118], [508, 100],
];
function Branch({ blooms }: { blooms: number }) {
  return (
    <svg className="fixed top-0 left-0 z-0 pointer-events-none" width="560" height="170" viewBox="0 0 560 170">
      <g stroke="#6b5544" strokeLinecap="round" fill="none" opacity="0.28">
        <path d="M-10 20 C 90 40, 170 55, 270 60 S 460 62, 552 84" strokeWidth="7" />
        <path d="M150 52 C 190 40, 214 34, 232 24" strokeWidth="4" />
        <path d="M270 60 C 300 50, 320 44, 344 60 " strokeWidth="4" />
        <path d="M360 64 C 390 52, 412 46, 438 52" strokeWidth="3.5" />
        <path d="M300 62 C 316 84, 330 100, 322 124" strokeWidth="3" />
        <path d="M420 68 C 440 88, 452 104, 448 122" strokeWidth="3" />
      </g>
      {BLOSSOM_SPOTS.slice(0, blooms).map(([x, y], i) => (
        <g key={i} className="bloom" style={{ animationDelay: `${(i % 4) * 0.18}s` }}>
          {[0, 72, 144, 216, 288].map((a) => (
            <ellipse key={a} cx={x + 4.6 * Math.cos((a * Math.PI) / 180)} cy={y + 4.6 * Math.sin((a * Math.PI) / 180)}
              rx="3.4" ry="2.6" fill={i % 3 ? "#f2a9c4" : "#e77fa8"} opacity="0.82"
              transform={`rotate(${a} ${x} ${y})`} />
          ))}
          <circle cx={x} cy={y} r="1.6" fill="#fff" opacity="0.9" />
        </g>
      ))}
    </svg>
  );
}

export default function App() {
  const route = useRoute();
  const view = route.split("/")[1] ?? "calendar";
  const [activity, setActivity] = useState(() => Number(localStorage.getItem("pos_activity") ?? 0));
  useEffect(() => {
    const bump = () => {
      setActivity((a) => {
        const n = a + 1;
        localStorage.setItem("pos_activity", String(n));
        return n;
      });
    };
    document.addEventListener("click", bump);
    return () => document.removeEventListener("click", bump);
  }, []);
  const blooms = Math.min(20, Math.floor(activity / 6)); // a blossom every ~6 interactions
  const activeDock =
    view === "contact" ? "#/relationships" : `#/${view === "settings" ? "" : view}`;

  return (
    <div className="h-full relative">
      {/* slim drag strip replaces the old sidebar's drag region */}
      <div className="drag-region absolute top-0 left-0 right-0 h-9 z-10" />
      <Branch blooms={blooms} />
      <Petals />

      <main className="h-full overflow-auto pb-28">
        {view === "calendar" && <Calendar />}
        {view === "relationships" && <Relationships subroute={route.split("/")[2] ?? ""} />}
        {view === "contact" && <ContactDetail id={Number(route.split("/")[2])} />}
        {view === "messaging" && <Inbox />}
        {view === "settings" && <Settings />}
      </main>

      {/* settings gear — bottom left */}
      <a
        href="#/settings"
        title="Settings"
        className="no-drag fixed bottom-4 left-4 z-20 flex items-center justify-center w-9 h-9 rounded-full border bg-white/90 backdrop-blur shadow-sm transition-transform hover:scale-105"
        style={{
          borderColor: "var(--line)",
          color: view === "settings" ? "var(--accent)" : "var(--muted)",
          background: "color-mix(in srgb, white 70%, var(--pink-1))",
        }}
      >
        {ICONS.settings}
      </a>

      {/* three free-floating icons on a gentle arc — pink ombre, per the sketch */}
      <nav className="no-drag fixed bottom-5 left-1/2 -translate-x-1/2 z-20 flex items-end gap-7">
        {DOCK.map((d, i) => {
          const active = activeDock === d.href;
          const ombre = [
            "radial-gradient(circle at 32% 28%, var(--pink-1) 8%, var(--pink-2) 68%, var(--pink-3) 100%)",
            "radial-gradient(circle at 32% 28%, var(--pink-2) 8%, var(--pink-3) 66%, var(--petal-deep) 100%)",
            "radial-gradient(circle at 32% 28%, var(--pink-3) 8%, var(--petal-deep) 62%, var(--accent) 100%)",
          ][i];
          return (
            <a
              key={d.href}
              href={d.href}
              title={d.label}
              className="watercolor-blob flex items-center justify-center w-12 h-12 shadow-md transition-transform hover:scale-110"
              style={{
                transform: `translateY(${d.lift}px)`,
                background: ombre,
                color: active ? "white" : "var(--ink)",
                boxShadow: active
                  ? "0 4px 14px color-mix(in srgb, var(--accent) 45%, transparent)"
                  : "0 2px 8px rgba(91,70,54,0.15)",
              }}
            >
              {ICONS[d.icon]}
            </a>
          );
        })}
      </nav>
    </div>
  );
}

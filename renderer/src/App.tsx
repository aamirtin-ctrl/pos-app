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

export default function App() {
  const route = useRoute();
  const view = route.split("/")[1] ?? "calendar";
  const activeDock =
    view === "contact" ? "#/relationships" : `#/${view === "settings" ? "" : view}`;

  return (
    <div className="h-full relative">
      {/* slim drag strip replaces the old sidebar's drag region */}
      <div className="drag-region absolute top-0 left-0 right-0 h-9 z-10" />

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
        }}
      >
        {ICONS.settings}
      </a>

      {/* curved dock — bottom center */}
      <nav
        className="no-drag fixed bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-end gap-2 px-5 pt-2 pb-2.5 rounded-full border bg-white/90 backdrop-blur shadow-lg"
        style={{ borderColor: "var(--line)" }}
      >
        {DOCK.map((d) => {
          const active = activeDock === d.href;
          return (
            <a
              key={d.href}
              href={d.href}
              title={d.label}
              className="flex flex-col items-center gap-0.5 px-3 py-1 rounded-2xl transition-transform hover:scale-105"
              style={{ transform: `translateY(${d.lift}px)`, color: active ? "var(--accent)" : "var(--muted)" }}
            >
              <span
                className="flex items-center justify-center w-10 h-10 rounded-full"
                style={{ background: active ? "var(--accent-soft)" : "transparent" }}
              >
                {ICONS[d.icon]}
              </span>
              <span className="text-[10px] font-medium">{d.label}</span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}

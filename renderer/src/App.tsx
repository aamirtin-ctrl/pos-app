import React, { useEffect, useState } from "react";
import Calendar from "./calendar/DayPlanner.tsx";
import Relationships from "./relationships/Home.tsx";
import Contacts from "./relationships/Contacts.tsx";
import ContactDetail from "./relationships/ContactDetail.tsx";
import Inbox from "./inbox/Stub.tsx";
import Settings from "./settings/Settings.tsx";

// Tiny hash router: #/calendar #/relationships #/contacts #/contact/:id #/inbox #/settings
export function useRoute(): string {
  const [route, setRoute] = useState(window.location.hash || "#/calendar");
  useEffect(() => {
    const fn = () => setRoute(window.location.hash || "#/calendar");
    window.addEventListener("hashchange", fn);
    return () => window.removeEventListener("hashchange", fn);
  }, []);
  return route;
}

const NAV = [
  ["#/calendar", "Calendar"],
  ["#/relationships", "Relationships"],
  ["#/contacts", "Contacts"],
  ["#/inbox", "Inbox"],
  ["#/settings", "Settings"],
] as const;

export default function App() {
  const route = useRoute();
  const view = route.split("/")[1] ?? "calendar";
  return (
    <div className="flex h-full">
      <aside className="w-52 shrink-0 border-r flex flex-col" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
        <div className="drag-region h-12 flex items-end px-4 pb-1">
          <span className="font-display text-lg font-semibold tracking-tight">POS</span>
        </div>
        <nav className="px-2 py-3 space-y-0.5 no-drag">
          {NAV.map(([href, label]) => (
            <a
              key={href}
              href={href}
              className={`block rounded-md px-3 py-1.5 text-sm ${
                route.startsWith(href) || (href === "#/relationships" && view === "contact")
                  ? "bg-white shadow-sm font-medium"
                  : "hover:bg-white/60"
              }`}
              style={{ color: "var(--ink)" }}
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="mt-auto p-3 text-[11px]" style={{ color: "var(--muted)" }}>
          local-first · your data stays here
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        {view === "calendar" && <Calendar />}
        {view === "relationships" && <Relationships />}
        {view === "contacts" && <Contacts />}
        {view === "contact" && <ContactDetail id={Number(route.split("/")[2])} />}
        {view === "inbox" && <Inbox />}
        {view === "settings" && <Settings />}
      </main>
    </div>
  );
}

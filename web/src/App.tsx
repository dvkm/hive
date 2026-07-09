import { NavLink, Route, Routes } from "react-router-dom";
import { useStore } from "./lib/store";
import Board from "./views/Board";
import TaskPage from "./views/Task";
import Decisions from "./views/Decisions";
import Policies from "./views/Policies";
import Monitors from "./views/Monitors";

function ConnDot() {
  const { sse } = useStore();
  const label = sse === "open" ? "live" : sse === "connecting" ? "connecting" : "reconnecting";
  return (
    <span className={`conn conn-${sse}`} title={`SSE ${label}`}>
      <span className="conn-dot" />
      {label}
    </span>
  );
}

export default function App() {
  const { decisions } = useStore();
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◆</span> hive
        </div>
        <nav className="nav">
          <NavLink to="/" end>
            Board
          </NavLink>
          <NavLink to="/decisions">
            Decisions
            {decisions.length > 0 && <span className="badge">{decisions.length}</span>}
          </NavLink>
          <NavLink to="/policies">Policies</NavLink>
          <NavLink to="/monitors">Monitors</NavLink>
        </nav>
        <ConnDot />
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<Board />} />
          <Route path="/tasks/:id" element={<TaskPage />} />
          <Route path="/decisions" element={<Decisions />} />
          <Route path="/policies" element={<Policies />} />
          <Route path="/monitors" element={<Monitors />} />
        </Routes>
      </main>
    </div>
  );
}

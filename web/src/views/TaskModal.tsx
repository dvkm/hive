import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { TaskBody } from "./Task";

// Rendered over the board (which stays mounted underneath, see App.tsx) when
// location.state.backgroundLocation is set. Closing goes back one history
// entry, which lands on the background location that was current when the
// modal was opened.
export default function TaskModal() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const close = () => navigate(-1);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="modal-backdrop task-modal-backdrop" onMouseDown={close}>
      <div className="task-modal-panel" onMouseDown={(e) => e.stopPropagation()}>
        <button className="task-modal-close" onClick={close} aria-label="Close">
          ✕
        </button>
        <TaskBody id={id} />
      </div>
    </div>
  );
}

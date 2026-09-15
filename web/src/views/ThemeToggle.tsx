import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleHalfStroke } from "@fortawesome/free-solid-svg-icons";
import { useTheme } from "../lib/theme";

export function ThemeToggle() {
  const [theme, toggle] = useTheme();
  const next = theme === "light" ? "dark" : "light";
  return (
    <button className="offline-toggle theme-toggle" title={`Switch to the ${next} theme`} aria-label={`Switch to the ${next} theme`} onClick={toggle}>
      <FontAwesomeIcon icon={faCircleHalfStroke} />
    </button>
  );
}

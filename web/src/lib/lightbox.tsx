// Dependency-free full-size image viewer. One overlay, rendered once at the app
// root; any view calls openLightbox(images, index) to show a set and navigate it
// with arrow keys / on-screen arrows. Esc or a backdrop click closes.
import { createContext, useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { relTime } from "./time";

export interface LightboxImage {
  url: string;
  caption?: string | null;
  taskId?: string | null;
  taskTitle?: string | null;
  ts?: string | null;
}

interface LightboxCtx {
  open: (images: LightboxImage[], index: number) => void;
}

const Ctx = createContext<LightboxCtx | null>(null);

export const useLightbox = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useLightbox outside provider");
  return c;
};

export function LightboxProvider({ children }: { children: React.ReactNode }) {
  const [images, setImages] = useState<LightboxImage[] | null>(null);
  const [idx, setIdx] = useState(0);

  const open = (imgs: LightboxImage[], index: number) => {
    if (!imgs.length) return;
    setImages(imgs);
    setIdx(Math.max(0, Math.min(index, imgs.length - 1)));
  };
  const close = () => setImages(null);

  useEffect(() => {
    if (!images) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") setIdx((i) => Math.max(0, i - 1));
      else if (e.key === "ArrowRight") setIdx((i) => Math.min(images.length - 1, i + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [images]);

  return (
    <Ctx.Provider value={{ open }}>
      {children}
      {images && (
        <Overlay images={images} idx={idx} setIdx={setIdx} close={close} />
      )}
    </Ctx.Provider>
  );
}

function Overlay({
  images,
  idx,
  setIdx,
  close,
}: {
  images: LightboxImage[];
  idx: number;
  setIdx: (updater: (i: number) => number) => void;
  close: () => void;
}) {
  const img = images[idx];
  const many = images.length > 1;
  const prev = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIdx((i) => Math.max(0, i - 1));
  };
  const next = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIdx((i) => Math.min(images.length - 1, i + 1));
  };
  return (
    <div className="lightbox" onClick={close} role="dialog" aria-modal="true">
      <button className="lb-close" onClick={close} aria-label="Close">
        ✕
      </button>
      {many && (
        <button className="lb-arrow lb-prev" onClick={prev} disabled={idx === 0} aria-label="Previous">
          ‹
        </button>
      )}
      <figure className="lb-figure" onClick={(e) => e.stopPropagation()}>
        <img className="lb-img" src={img.url} alt={img.caption || "evidence"} />
        <figcaption className="lb-caption">
          <div className="lb-cap-text">{img.caption || "(no caption)"}</div>
          <div className="lb-cap-meta">
            {img.taskId && (
              <Link className="lb-task" to={`/tasks/${img.taskId}`} onClick={close}>
                {img.taskTitle || "View task"} →
              </Link>
            )}
            {img.ts && (
              <span className="lb-ts" title={img.ts}>
                {relTime(img.ts)}
              </span>
            )}
            {many && (
              <span className="lb-count">
                {idx + 1} / {images.length}
              </span>
            )}
          </div>
        </figcaption>
      </figure>
      {many && (
        <button
          className="lb-arrow lb-next"
          onClick={next}
          disabled={idx === images.length - 1}
          aria-label="Next"
        >
          ›
        </button>
      )}
    </div>
  );
}

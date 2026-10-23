// React wrapper for the Pixi.js v8 office scene. It mounts a canvas, creates the
// OfficeScene in a useEffect (awaiting the v8 async Application.init), and
// destroys it on unmount so GPU resources are released. The scene reads the
// vanilla Zustand store directly every frame, so this component never re-renders
// in response to agent traffic.

import { useEffect, useRef } from "react";
import { OfficeScene } from "./officeScene";
import { officeStore } from "../store/store";

export function OfficeSceneView() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = new OfficeScene(officeStore);
    let disposed = false;

    void scene.init(canvas).then(() => {
      // If the component unmounted before init resolved, tear down immediately.
      if (disposed) scene.destroy();
    });

    return () => {
      disposed = true;
      scene.destroy();
    };
  }, []);

  return (
    <div className="scene-wrap">
      <canvas ref={canvasRef} className="scene-canvas" />
    </div>
  );
}

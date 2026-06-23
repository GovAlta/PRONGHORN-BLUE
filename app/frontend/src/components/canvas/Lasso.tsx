import { useRef, useEffect, type PointerEvent } from "react";
import { useReactFlow, useStore, type Node } from "reactflow";
import { pointsToPath } from "@/lib/lassoUtils";

type NodePoints = [number, number][];
type NodePointObject = Record<string, NodePoints>;

export function Lasso({
  partial,
  setNodes,
}: {
  partial: boolean;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
}) {
  const { getNodes } = useReactFlow();
  const { width, height } = useStore((state) => ({
    width: state.width,
    height: state.height,
  }));

  const canvas = useRef<HTMLCanvasElement>(null);
  const ctx = useRef<CanvasRenderingContext2D | null>(null);

  const nodePoints = useRef<NodePointObject>({});
  const pointRef = useRef<[number, number][]>([]);
  const shiftKeyPressed = useRef(false);
  const previouslySelected = useRef<Set<string>>(new Set());

  // Track Shift key state
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        shiftKeyPressed.current = true;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        shiftKeyPressed.current = false;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  function handlePointerDown(e: PointerEvent) {
    const c = canvas.current;
    if (!c) return;

    c.setPointerCapture(e.pointerId);

    const rect = c.getBoundingClientRect();
    const nextPoints: [number, number][] = [[
      e.clientX - rect.left,
      e.clientY - rect.top,
    ]];
    pointRef.current = nextPoints;

    // Store currently selected nodes if Shift is held
    if (shiftKeyPressed.current) {
      const nodes = getNodes();
      previouslySelected.current = new Set(
        nodes.filter(n => n.selected).map(n => n.id)
      );
    } else {
      previouslySelected.current = new Set();
    }

    nodePoints.current = {};
    const nodes = getNodes();

    for (const node of nodes) {
      const el = document.querySelector(
        `[data-id="${node.id}"]`,
      ) as HTMLDivElement | null;
      if (!el) continue;

      const r = el.getBoundingClientRect();

      const left = r.left - rect.left;
      const right = r.right - rect.left;
      const top = r.top - rect.top;
      const bottom = r.bottom - rect.top;
      const centerX = (left + right) / 2;
      const centerY = (top + bottom) / 2;

      // Sample multiple points: corners, midpoints, and center
      const localPoints: [number, number][] = [
        [left, top], // top-left corner
        [right, top], // top-right corner
        [right, bottom], // bottom-right corner
        [left, bottom], // bottom-left corner
        [centerX, top], // top-middle
        [right, centerY], // right-middle
        [centerX, bottom], // bottom-middle
        [left, centerY], // left-middle
        [centerX, centerY], // center
      ];

      nodePoints.current[node.id] = localPoints;
    }

    ctx.current = c.getContext("2d");
    if (!ctx.current) return;
    ctx.current.lineWidth = 1;
    ctx.current.fillStyle = "rgba(0, 89, 220, 0.08)";
    ctx.current.strokeStyle = "rgba(0, 89, 220, 0.8)";
  }

  function handlePointerMove(e: PointerEvent) {
    if (e.buttons !== 1) return;

    const c = canvas.current;
    if (!c || !ctx.current) return;

    const rect = c.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const points = pointRef.current;
    const nextPoints = [...points, [x, y]] as [number, number][];
    pointRef.current = nextPoints;

    // Visual stroke path (smooth freehand line)
    const strokePath = new Path2D(pointsToPath(nextPoints));

    // Hit-test polygon path (interior of the lasso loop)
    const hitPath = new Path2D();
    if (nextPoints.length > 0) {
      hitPath.moveTo(nextPoints[0][0], nextPoints[0][1]);
      for (let i = 1; i < nextPoints.length; i++) {
        hitPath.lineTo(nextPoints[i][0], nextPoints[i][1]);
      }
      hitPath.closePath();
    }

    ctx.current.clearRect(0, 0, width, height);
    ctx.current.fill(strokePath);
    ctx.current.stroke(strokePath);

    const nodesToSelect = new Set<string>();

    for (const [nodeId, pts] of Object.entries(nodePoints.current)) {
      if (partial) {
        // Any sampled point of the node inside the lasso interior
        if (pts.some(([px, py]) => ctx.current!.isPointInPath(hitPath, px, py))) {
          nodesToSelect.add(nodeId);
        }
      } else {
        // All sampled points must be inside the lasso interior
        if (pts.every(([px, py]) => ctx.current!.isPointInPath(hitPath, px, py))) {
          nodesToSelect.add(nodeId);
        }
      }
    }

    // Merge with previously selected nodes if Shift is held
    if (shiftKeyPressed.current) {
      previouslySelected.current.forEach(id => nodesToSelect.add(id));
    }

    setNodes((nodes) =>
      nodes.map((node) => ({
        ...node,
        selected: nodesToSelect.has(node.id),
      })),
    );
  }

  function handlePointerUp(e: PointerEvent) {
    const c = canvas.current;
    if (c) {
      c.releasePointerCapture(e.pointerId);
    }
    pointRef.current = [];
    previouslySelected.current = new Set();
    if (ctx.current) {
      ctx.current.clearRect(0, 0, width, height);
    }
  }

  return (
    <canvas
      ref={canvas}
      width={width}
      height={height}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        pointerEvents: "all",
        zIndex: 10,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    />
  );
}

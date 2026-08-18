import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, type EdgeProps } from '@xyflow/react';

/**
 * Edges already delete via the browser's normal React Flow behaviour -- click
 * to select, press Backspace or Delete. This adds a visible affordance for
 * people who do not know that: a small "x" at the midpoint, shown once the
 * edge is selected so the canvas is not cluttered with buttons at rest.
 */
export function RemovableEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  style, markerEnd, selected,
}: EdgeProps) {
  const { deleteElements } = useReactFlow();
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  });

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {selected && (
        <EdgeLabelRenderer>
          <button
            className="edge-del"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onClick={(e) => {
              e.stopPropagation();
              deleteElements({ edges: [{ id }] });
            }}
            title="Remove connection"
          >
            ×
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = { removable: RemovableEdge };

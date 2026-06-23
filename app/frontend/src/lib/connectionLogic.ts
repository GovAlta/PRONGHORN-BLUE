import connectionData from "../../public/data/connectionLogic.json";

export interface FlowLevel {
  level: number;
  types: string[];
}

export interface ValidConnection {
  source: string;
  targets: string[];
  label: string;
}

export interface ConnectionLogic {
  version: string;
  description: string;
  flowHierarchy: {
    description: string;
    levels: FlowLevel[];
  };
  validConnections: ValidConnection[];
  xPositions: Record<string, number>;
  categoryOrder: string[];
  categoryLabels: Record<string, string>;
}

export const connectionLogic: ConnectionLogic = connectionData as ConnectionLogic;

/**
 * Get the flow level (1-11) for a node type
 * Lower levels are on the left, higher on the right
 */
export function getFlowLevel(nodeType: string): number {
  for (const level of connectionLogic.flowHierarchy.levels) {
    if (level.types.includes(nodeType)) {
      return level.level;
    }
  }
  return 5; // Default to middle level
}

/**
 * Get the X position for a node type on the canvas
 */
export function getXPosition(nodeType: string): number {
  return connectionLogic.xPositions[nodeType] ?? 700;
}

/**
 * Check if a connection from source to target is valid
 */
export function isValidConnection(sourceType: string, targetType: string): boolean {
  const connection = connectionLogic.validConnections.find(c => c.source === sourceType);
  return connection?.targets.includes(targetType) ?? false;
}

/**
 * Get the label for a connection between two node types
 */
export function getConnectionLabel(sourceType: string, targetType: string): string {
  const connection = connectionLogic.validConnections.find(
    c => c.source === sourceType && c.targets.includes(targetType)
  );
  return connection?.label ?? "connects to";
}

/**
 * Get all valid target types for a given source type
 */
export function getValidTargets(sourceType: string): string[] {
  const connection = connectionLogic.validConnections.find(c => c.source === sourceType);
  return connection?.targets ?? [];
}

/**
 * Build FLOW_ORDER map from flow hierarchy (for edge functions)
 */
export function buildFlowOrderMap(): Record<string, number> {
  const flowOrder: Record<string, number> = {};
  for (const level of connectionLogic.flowHierarchy.levels) {
    for (const type of level.types) {
      flowOrder[type] = level.level;
    }
  }
  return flowOrder;
}

/**
 * Get category display label
 */
export function getCategoryLabel(category: string): string {
  return connectionLogic.categoryLabels[category] ?? category;
}

/**
 * Get ordered list of categories
 */
export function getCategoryOrder(): string[] {
  return connectionLogic.categoryOrder;
}

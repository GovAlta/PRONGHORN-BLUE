import { memo, useMemo } from "react";
import { Handle, Position, NodeProps } from "reactflow";
import { 
  Box, 
  Database, 
  Globe, 
  Webhook, 
  Shield, 
  ShieldCheck, 
  FileText, 
  ListChecks, 
  Code,
  FolderKanban,
  FileCode,
  Layers,
  Server,
  GitBranch,
  Filter,
  Cpu,
  Wrench,
  Table2,
  TableProperties,
  Bot,
  MoreHorizontal,
  LucideIcon
} from "lucide-react";

// Icon mapping from string names to Lucide components
const iconMap: Record<string, LucideIcon> = {
  FolderKanban,
  FileCode,
  Box,
  Database,
  Globe,
  Webhook,
  Shield,
  ShieldCheck,
  FileText,
  ListChecks,
  Code,
  Layers,
  Server,
  GitBranch,
  Filter,
  Cpu,
  Wrench,
  Table2,
  TableProperties,
  Bot,
  MoreHorizontal,
};

// Legacy fallback icons (for backward compatibility)
const legacyNodeIcons: Record<string, LucideIcon> = {
  PROJECT: FolderKanban,
  PAGE: FileCode,
  COMPONENT: Box,
  WEB_COMPONENT: Box,
  HOOK_COMPOSABLE: Layers,
  API: Code,
  API_SERVICE: Server,
  API_ROUTER: GitBranch,
  API_MIDDLEWARE: Filter,
  API_CONTROLLER: Cpu,
  API_UTIL: Wrench,
  DATABASE: Database,
  SCHEMA: TableProperties,
  TABLE: Table2,
  SERVICE: Globe,
  EXTERNAL_SERVICE: Globe,
  WEBHOOK: Webhook,
  FIREWALL: Shield,
  SECURITY: ShieldCheck,
  REQUIREMENT: FileText,
  STANDARD: ListChecks,
  TECH_STACK: Code,
  AGENT: Bot,
  OTHER: MoreHorizontal,
};

// Legacy fallback colors (for backward compatibility)
const legacyNodeColors: Record<string, string> = {
  PROJECT: "bg-cyan-500/10 border-cyan-500/50 text-cyan-700 dark:text-cyan-400",
  PAGE: "bg-sky-500/10 border-sky-500/50 text-sky-700 dark:text-sky-400",
  COMPONENT: "bg-blue-500/10 border-blue-500/50 text-blue-700 dark:text-blue-400",
  WEB_COMPONENT: "bg-blue-500/10 border-blue-500/50 text-blue-700 dark:text-blue-400",
  HOOK_COMPOSABLE: "bg-violet-500/10 border-violet-500/50 text-violet-700 dark:text-violet-400",
  API: "bg-green-500/10 border-green-500/50 text-green-700 dark:text-green-400",
  API_SERVICE: "bg-green-500/10 border-green-500/50 text-green-700 dark:text-green-400",
  API_ROUTER: "bg-lime-500/10 border-lime-500/50 text-lime-700 dark:text-lime-400",
  API_MIDDLEWARE: "bg-amber-500/10 border-amber-500/50 text-amber-700 dark:text-amber-400",
  API_CONTROLLER: "bg-emerald-500/10 border-emerald-500/50 text-emerald-700 dark:text-emerald-400",
  API_UTIL: "bg-stone-500/10 border-stone-500/50 text-stone-700 dark:text-stone-400",
  DATABASE: "bg-purple-500/10 border-purple-500/50 text-purple-700 dark:text-purple-400",
  SCHEMA: "bg-fuchsia-500/10 border-fuchsia-500/50 text-fuchsia-700 dark:text-fuchsia-400",
  TABLE: "bg-rose-500/10 border-rose-500/50 text-rose-700 dark:text-rose-400",
  SERVICE: "bg-orange-500/10 border-orange-500/50 text-orange-700 dark:text-orange-400",
  EXTERNAL_SERVICE: "bg-orange-500/10 border-orange-500/50 text-orange-700 dark:text-orange-400",
  WEBHOOK: "bg-pink-500/10 border-pink-500/50 text-pink-700 dark:text-pink-400",
  FIREWALL: "bg-red-500/10 border-red-500/50 text-red-700 dark:text-red-400",
  SECURITY: "bg-yellow-500/10 border-yellow-500/50 text-yellow-700 dark:text-yellow-400",
  REQUIREMENT: "bg-indigo-500/10 border-indigo-500/50 text-indigo-700 dark:text-indigo-400",
  STANDARD: "bg-teal-500/10 border-teal-500/50 text-teal-700 dark:text-teal-400",
  TECH_STACK: "bg-gray-500/10 border-gray-500/50 text-gray-700 dark:text-gray-400",
  AGENT: "bg-cyan-600/10 border-cyan-600/50 text-cyan-800 dark:text-cyan-300",
  OTHER: "bg-slate-500/10 border-slate-500/50 text-slate-700 dark:text-slate-400",
};

interface CanvasNodeProps extends NodeProps {
  nodeTypesConfig?: {
    icon?: string;
    color_class?: string;
  };
}

export const CanvasNode = memo(({ data, selected }: CanvasNodeProps) => {
  const nodeType = data.type as string || "COMPONENT";
  
  // Get icon - try from data config first, then fallback
  const Icon = useMemo(() => {
    if (data.iconName && iconMap[data.iconName]) {
      return iconMap[data.iconName];
    }
    return legacyNodeIcons[nodeType] || Box;
  }, [nodeType, data.iconName]);
  
  // Get color class - try from data config first, then fallback
  const colorClass = useMemo(() => {
    if (data.colorClass) {
      return data.colorClass;
    }
    return legacyNodeColors[nodeType] || legacyNodeColors.OTHER;
  }, [nodeType, data.colorClass]);

  return (
    <div
      className={`
        px-4 py-3 rounded-lg border-2 min-w-[180px]
        ${colorClass}
        ${selected ? "ring-2 ring-primary ring-offset-2" : ""}
        transition-all duration-200
      `}
    >
      <Handle type="target" position={Position.Left} className="w-3 h-3" />
      
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{data.label || "New Node"}</div>
          {data.subtitle && (
            <div className="text-xs opacity-70 mt-0.5 break-words whitespace-pre-wrap max-w-[200px]">
              {data.subtitle.length > 200 
                ? data.subtitle.slice(0, 200) + "..." 
                : data.subtitle}
            </div>
          )}
        </div>
      </div>
      
      <Handle type="source" position={Position.Right} className="w-3 h-3" />
    </div>
  );
});

CanvasNode.displayName = "CanvasNode";

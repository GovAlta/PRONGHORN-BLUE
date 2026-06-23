import { useEffect, useMemo } from "react";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { ArrowRight, Sparkles, Ban, CheckCircle2 } from "lucide-react";

interface TableColumn {
  name: string;
  type: string;
  nullable: boolean;
}

interface ColumnMapping {
  sourceColumn: string;
  targetColumn: string | null;
  ignored: boolean;
  constantValue?: string;
  castingEnabled: boolean;
}

interface FieldMapperProps {
  sourceHeaders: string[];
  targetTables: string[];
  selectedTable: string;
  onTableChange: (table: string) => void;
  targetColumns: TableColumn[];
  mappings: ColumnMapping[];
  onMappingsChange: (mappings: ColumnMapping[]) => void;
  enableCasting: boolean;
  onEnableCastingChange: (enabled: boolean) => void;
}

export default function FieldMapper({
  sourceHeaders,
  targetTables,
  selectedTable,
  onTableChange,
  targetColumns,
  mappings,
  onMappingsChange,
  enableCasting,
  onEnableCastingChange
}: FieldMapperProps) {
  // Filter out invalid target columns (null/undefined names)
  const validTargetColumns = useMemo(() => 
    targetColumns?.filter(col => col?.name && typeof col.name === "string") || [],
    [targetColumns]
  );

  // Auto-match columns on initial load or table change
  useEffect(() => {
    if (mappings.length === 0 || mappings.every(m => m.targetColumn === null)) {
      // Filter out undefined/null source headers
      const validHeaders = sourceHeaders?.filter(h => h != null && h !== "") || [];
      
      const autoMapped = validHeaders.map(source => {
        // Try exact match (case insensitive) with null checks
        const exactMatch = validTargetColumns?.find(
          tc => tc?.name && source && 
               tc.name.toLowerCase() === source.toLowerCase()
        );
        
        // Try fuzzy match (contains, underscores vs spaces) with null checks
        const fuzzyMatch = !exactMatch ? validTargetColumns?.find(tc => {
          if (!tc?.name || !source) return false;
          const normalizedSource = source.toLowerCase().replace(/[_\s-]/g, "");
          const normalizedTarget = tc.name.toLowerCase().replace(/[_\s-]/g, "");
          return normalizedSource === normalizedTarget ||
                 normalizedTarget.includes(normalizedSource) ||
                 normalizedSource.includes(normalizedTarget);
        }) : null;

        return {
          sourceColumn: source,
          targetColumn: exactMatch?.name || fuzzyMatch?.name || null,
          ignored: false,
          castingEnabled: true
        };
      });

      onMappingsChange(autoMapped);
    }
  }, [selectedTable, validTargetColumns, sourceHeaders]);

  const updateMapping = (idx: number, updates: Partial<ColumnMapping>) => {
    onMappingsChange(mappings.map((m, i) => 
      i === idx ? { ...m, ...updates } : m
    ));
  };

  const mappedCount = mappings.filter(m => m.targetColumn && !m.ignored).length;
  const ignoredCount = mappings.filter(m => m.ignored).length;

  const getMatchStatus = (mapping: ColumnMapping) => {
    if (mapping.ignored) return "ignored";
    if (!mapping.targetColumn) return "unmapped";
    const isExactMatch = validTargetColumns?.some(
      tc => tc?.name && mapping.sourceColumn && 
           tc.name.toLowerCase() === mapping.sourceColumn.toLowerCase()
    );
    return isExactMatch ? "exact" : "fuzzy";
  };

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Target Table Selection */}
      <div className="space-y-2">
        <Label>Target Table</Label>
        <Select value={selectedTable} onValueChange={onTableChange}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select target table" />
          </SelectTrigger>
          <SelectContent>
            {targetTables.map(table => (
              <SelectItem key={table} value={table}>
                {table}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Options */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Switch
            id="enable-casting"
            checked={enableCasting}
            onCheckedChange={onEnableCastingChange}
          />
          <Label htmlFor="enable-casting" className="text-sm cursor-pointer">
            Enable type casting (convert strings to numbers, dates, etc.)
          </Label>
        </div>
        
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            {mappedCount} mapped
          </span>
          <span className="flex items-center gap-1">
            <Ban className="h-4 w-4 text-muted-foreground" />
            {ignoredCount} ignored
          </span>
        </div>
      </div>

      {/* Info message if no target columns */}
      {validTargetColumns.length === 0 && selectedTable && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-sm text-amber-700">
          No columns found for the selected table. Please verify the table exists and has columns.
        </div>
      )}

      {/* Mapping Table */}
      <div className="flex-1 border rounded-lg min-h-0 overflow-auto">
        <table className="min-w-max text-sm">
          <thead className="sticky top-0 bg-muted/80 backdrop-blur z-10">
            <tr>
              <th className="px-3 py-2 border-b text-left font-medium min-w-[150px] bg-muted/80">Source Column</th>
              <th className="px-3 py-2 border-b text-center font-medium w-12 bg-muted/80">
                <ArrowRight className="h-4 w-4 mx-auto" />
              </th>
              <th className="px-3 py-2 border-b text-left font-medium min-w-[200px] bg-muted/80">Target Column</th>
              <th className="px-3 py-2 border-b text-center font-medium w-20 bg-muted/80">Ignore</th>
              <th className="px-3 py-2 border-b text-center font-medium w-20 bg-muted/80">Cast</th>
              <th className="px-3 py-2 border-b text-left font-medium min-w-[120px] bg-muted/80">Status</th>
            </tr>
          </thead>
          <tbody>
            {mappings.map((mapping, idx) => {
              const status = getMatchStatus(mapping);
              validTargetColumns.find(tc => tc.name === mapping.targetColumn);
              
              return (
                <tr 
                  key={idx} 
                  className={cn(
                    "hover:bg-muted/30",
                    mapping.ignored && "opacity-50"
                  )}
                >
                  <td className="px-3 py-2 border-b">
                    <span className="font-mono text-xs">{mapping.sourceColumn}</span>
                  </td>
                  <td className="px-3 py-2 border-b text-center">
                    <ArrowRight className={cn(
                      "h-4 w-4 mx-auto",
                      mapping.ignored && "text-muted-foreground",
                      !mapping.ignored && mapping.targetColumn && "text-green-500"
                    )} />
                  </td>
                  <td className="px-3 py-2 border-b">
                    {mapping.ignored ? (
                      <span className="text-muted-foreground italic">—</span>
                    ) : (
                      <Select
                        value={mapping.targetColumn || "_none_"}
                        onValueChange={(v) => updateMapping(idx, { 
                          targetColumn: v === "_none_" ? null : v 
                        })}
                      >
                        <SelectTrigger className="h-8 font-mono text-xs">
                          <SelectValue placeholder="Select column" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="_none_">
                            <span className="text-muted-foreground">— None —</span>
                          </SelectItem>
                          {validTargetColumns.map(col => (
                            <SelectItem 
                              key={col.name} 
                              value={col.name}
                              disabled={mappings.some(m => m.targetColumn === col.name && m !== mapping)}
                            >
                              <div className="flex items-center gap-2">
                                <span>{col.name}</span>
                                <Badge variant="outline" className="text-xs font-mono">
                                  {col.type}
                                </Badge>
                                {col.nullable && (
                                  <span className="text-xs text-muted-foreground">nullable</span>
                                )}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </td>
                  <td className="px-3 py-2 border-b text-center">
                    <Checkbox
                      checked={mapping.ignored}
                      onCheckedChange={(checked) => updateMapping(idx, { 
                        ignored: !!checked,
                        targetColumn: checked ? null : mapping.targetColumn
                      })}
                    />
                  </td>
                  <td className="px-3 py-2 border-b text-center">
                    <Checkbox
                      checked={mapping.castingEnabled && enableCasting}
                      onCheckedChange={(checked) => updateMapping(idx, { castingEnabled: !!checked })}
                      disabled={mapping.ignored || !enableCasting}
                    />
                  </td>
                  <td className="px-3 py-2 border-b">
                    {status === "exact" && (
                      <Badge variant="default" className="bg-green-500/20 text-green-700 border-green-500/30">
                        <Sparkles className="h-3 w-3 mr-1" />
                        Exact match
                      </Badge>
                    )}
                    {status === "fuzzy" && (
                      <Badge variant="secondary">
                        Fuzzy match
                      </Badge>
                    )}
                    {status === "unmapped" && (
                      <Badge variant="outline" className="text-amber-600 border-amber-500/30">
                        Unmapped
                      </Badge>
                    )}
                    {status === "ignored" && (
                      <Badge variant="outline" className="text-muted-foreground">
                        Ignored
                      </Badge>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Warnings */}
      {mappings.some(m => !m.targetColumn && !m.ignored) && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-sm text-amber-700">
          Some columns are not mapped. They will be skipped during import.
        </div>
      )}
    </div>
  );
}

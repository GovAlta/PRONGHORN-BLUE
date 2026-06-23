import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { 
  Copy, 
  Check, 
  Key, 
  KeyRound, 
  X,
  Columns,
  Hash,
  Type
} from "lucide-react";
import { toast } from "sonner";

interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  maxLength: number | null;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  foreignKeyRef?: string;
}

interface IndexInfo {
  name: string;
  definition: string;
}

interface TableStructureViewerProps {
  schema: string;
  table: string;
  columns: ColumnInfo[];
  indexes?: IndexInfo[];
  onClose?: () => void;
}

export function TableStructureViewer({
  schema,
  table,
  columns,
  indexes = [],
  onClose,
}: TableStructureViewerProps) {
  const [copiedItem, setCopiedItem] = useState<string | null>(null);

  const handleCopy = (text: string, itemId: string) => {
    navigator.clipboard.writeText(text);
    setCopiedItem(itemId);
    setTimeout(() => setCopiedItem(null), 1500);
  };

  const handleCopyAllColumns = () => {
    const columnDefs = columns.map(col => {
      let def = `"${col.name}" ${col.type.toUpperCase()}`;
      if (col.maxLength) def += `(${col.maxLength})`;
      if (!col.nullable) def += " NOT NULL";
      if (col.default) def += ` DEFAULT ${col.default}`;
      return def;
    }).join(",\n  ");
    navigator.clipboard.writeText(columnDefs);
    toast.success("Column definitions copied");
  };

  const handleCopyCreateTable = () => {
    const columnDefs = columns.map(col => {
      let def = `  "${col.name}" ${col.type.toUpperCase()}`;
      if (col.maxLength) def += `(${col.maxLength})`;
      if (!col.nullable) def += " NOT NULL";
      if (col.default) def += ` DEFAULT ${col.default}`;
      return def;
    }).join(",\n");

    const pkColumns = columns.filter(c => c.isPrimaryKey).map(c => `"${c.name}"`);
    const pkConstraint = pkColumns.length > 0 
      ? `,\n  PRIMARY KEY (${pkColumns.join(", ")})` 
      : "";

    const sql = `CREATE TABLE "${schema}"."${table}" (\n${columnDefs}${pkConstraint}\n);`;
    navigator.clipboard.writeText(sql);
    toast.success("CREATE TABLE statement copied");
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <Columns className="h-4 w-4 text-primary" />
          <span className="font-semibold text-sm">
            {schema}.{table}
          </span>
          <Badge variant="secondary" className="font-mono">
            {columns.length} columns
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopyAllColumns}
            className="h-7 text-xs"
          >
            <Copy className="h-3.5 w-3.5 mr-1" />
            Copy Columns
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopyCreateTable}
            className="h-7 text-xs"
          >
            <Copy className="h-3.5 w-3.5 mr-1" />
            Copy CREATE
          </Button>
          {onClose && (
            <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7">
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Columns Table */}
      <ScrollArea className="flex-1">
        <div className="min-w-max">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">#</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Column</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Type</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Nullable</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Default</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Keys</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground w-10"></th>
              </tr>
            </thead>
            <tbody>
              {columns.map((col, idx) => (
                <tr key={col.name} className="border-b border-border/50 hover:bg-muted/30">
                  <td className="px-3 py-2 text-muted-foreground font-mono text-xs">
                    {idx + 1}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Hash className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-mono font-medium">{col.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <Type className="h-3.5 w-3.5 text-muted-foreground" />
                      <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                        {col.type.toUpperCase()}
                        {col.maxLength && `(${col.maxLength})`}
                      </code>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge 
                      variant={col.nullable ? "secondary" : "outline"} 
                      className="text-[10px]"
                    >
                      {col.nullable ? "NULL" : "NOT NULL"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    {col.default ? (
                      <code className="text-xs bg-muted px-1.5 py-0.5 rounded truncate max-w-[200px] block">
                        {col.default}
                      </code>
                    ) : (
                      <span className="text-muted-foreground text-xs italic">none</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      {col.isPrimaryKey && (
                        <Badge variant="default" className="gap-1 text-[10px]">
                          <Key className="h-3 w-3" />
                          PK
                        </Badge>
                      )}
                      {col.isForeignKey && (
                        <Badge variant="secondary" className="gap-1 text-[10px]">
                          <KeyRound className="h-3 w-3" />
                          FK
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => handleCopy(col.name, `col-${col.name}`)}
                    >
                      {copiedItem === `col-${col.name}` ? (
                        <Check className="h-3 w-3 text-green-500" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Indexes Section */}
          {indexes.length > 0 && (
            <div className="border-t border-border mt-4">
              <div className="px-3 py-2 bg-muted/30">
                <span className="font-semibold text-sm">Indexes ({indexes.length})</span>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Name</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Definition</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {indexes.map((idx) => (
                    <tr key={idx.name} className="border-b border-border/50 hover:bg-muted/30">
                      <td className="px-3 py-2 font-mono text-xs">{idx.name}</td>
                      <td className="px-3 py-2">
                        <code className="text-xs bg-muted px-1.5 py-0.5 rounded block truncate max-w-[400px]">
                          {idx.definition}
                        </code>
                      </td>
                      <td className="px-3 py-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0"
                          onClick={() => handleCopy(idx.definition, `idx-${idx.name}`)}
                        >
                          {copiedItem === `idx-${idx.name}` ? (
                            <Check className="h-3 w-3 text-green-500" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { SheetData } from "@/utils/parseExcel";
import { CheckSquare, Square, Filter, ArrowUpDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

interface ExcelDataGridProps {
  sheets: SheetData[];
  selectedSheet: string;
  onSheetChange: (sheetName: string) => void;
  headerRow: number;
  onHeaderRowChange: (row: number) => void;
  selectedRows: Set<number>;
  onSelectedRowsChange: (rows: Set<number>) => void;
  maxPreviewRows?: number;
}

const PAGE_SIZE_OPTIONS = [100, 500, 1000, 5000] as const;

export default function ExcelDataGrid({
  sheets,
  selectedSheet,
  onSheetChange,
  headerRow,
  onHeaderRowChange,
  selectedRows,
  onSelectedRowsChange,
  maxPreviewRows = 100
}: ExcelDataGridProps) {
  const [filterText, setFilterText] = useState("");
  const [sortColumn, setSortColumn] = useState<number | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [pageSize, setPageSize] = useState<number>(100);
  const [currentPage, setCurrentPage] = useState(0);

  const currentSheet = useMemo(() => 
    sheets.find(s => s.name === selectedSheet) || sheets[0],
    [sheets, selectedSheet]
  );

  const headers = useMemo(() => {
    if (!currentSheet || headerRow >= currentSheet.rows.length) return [];
    return currentSheet.rows[headerRow] || [];
  }, [currentSheet, headerRow]);

  const dataRows = useMemo(() => {
    if (!currentSheet) return [];
    return currentSheet.rows.slice(headerRow + 1);
  }, [currentSheet, headerRow]);

  const filteredRows = useMemo(() => {
    let rows = dataRows.map((row, idx) => ({ row, originalIndex: idx }));
    
    // Apply filter
    if (filterText.trim()) {
      const lower = filterText.toLowerCase();
      rows = rows.filter(({ row }) => 
        row.some(cell => String(cell ?? "").toLowerCase().includes(lower))
      );
    }

    // Apply sort
    if (sortColumn !== null) {
      rows.sort((a, b) => {
        const aVal = a.row[sortColumn] ?? "";
        const bVal = b.row[sortColumn] ?? "";
        const cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true });
        return sortDirection === "asc" ? cmp : -cmp;
      });
    }

    return rows;
  }, [dataRows, filterText, sortColumn, sortDirection]);

  // Pagination calculations
  const totalPages = Math.ceil(filteredRows.length / pageSize);
  const startIndex = currentPage * pageSize;
  const endIndex = Math.min(startIndex + pageSize, filteredRows.length);
  const displayRows = filteredRows.slice(startIndex, endIndex);

  // Reset to first page when filter changes
  useMemo(() => {
    setCurrentPage(0);
  }, [filterText]);

  const handleSelectAll = () => {
    if (selectedRows.size === dataRows.length) {
      onSelectedRowsChange(new Set());
    } else {
      onSelectedRowsChange(new Set(dataRows.map((_, i) => i)));
    }
  };

  const handleRowSelect = (idx: number) => {
    const newSelected = new Set(selectedRows);
    if (newSelected.has(idx)) {
      newSelected.delete(idx);
    } else {
      newSelected.add(idx);
    }
    onSelectedRowsChange(newSelected);
  };

  const handleSort = (colIdx: number) => {
    if (sortColumn === colIdx) {
      setSortDirection(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortColumn(colIdx);
      setSortDirection("asc");
    }
  };

  const handlePageSizeChange = (value: string) => {
    const newSize = parseInt(value, 10);
    setPageSize(newSize);
    setCurrentPage(0);
  };

  const allSelected = selectedRows.size === dataRows.length && dataRows.length > 0;

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4">
        {sheets.length > 1 && (
          <div className="flex items-center gap-2">
            <Label className="text-sm">Sheet:</Label>
            <Select value={selectedSheet} onValueChange={onSheetChange}>
              <SelectTrigger className="w-40 h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sheets.map(s => (
                  <SelectItem key={s.name} value={s.name}>
                    {s.name} ({s.rows.length} rows)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Label className="text-sm">Header Row:</Label>
          <Select 
            value={String(headerRow)} 
            onValueChange={(v) => onHeaderRowChange(parseInt(v, 10))}
          >
            <SelectTrigger className="w-20 h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {currentSheet?.rows.slice(0, 10).map((_, i) => (
                <SelectItem key={i} value={String(i)}>Row {i + 1}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter rows..."
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            className="h-8"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSelectAll}
            className="h-8"
          >
            {allSelected ? <CheckSquare className="h-4 w-4 mr-1" /> : <Square className="h-4 w-4 mr-1" />}
            {allSelected ? "Deselect All" : "Select All"}
          </Button>
          <span className="text-sm text-muted-foreground">
            {selectedRows.size} of {dataRows.length} selected
          </span>
        </div>
      </div>

      {/* Data Grid with horizontal scroll */}
      <div className="flex-1 border rounded-lg overflow-hidden bg-background min-h-0">
        <div className="h-full overflow-auto">
          <table className="min-w-max text-sm">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur z-10">
              <tr>
                <th className="w-10 px-2 py-2 border-b border-r text-center sticky left-0 bg-muted/80 z-20">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={handleSelectAll}
                  />
                </th>
                <th className="w-12 px-2 py-2 border-b border-r text-center text-muted-foreground sticky left-10 bg-muted/80 z-20">#</th>
                {headers.map((header, idx) => (
                  <th 
                    key={idx}
                    className="px-3 py-2 border-b border-r text-left font-medium cursor-pointer hover:bg-muted/50 transition-colors min-w-[120px]"
                    onClick={() => handleSort(idx)}
                  >
                    <div className="flex items-center gap-1">
                      <span className="truncate max-w-[150px]">{String(header ?? `Column ${idx + 1}`)}</span>
                      {sortColumn === idx && (
                        <ArrowUpDown className={cn(
                          "h-3 w-3 flex-shrink-0",
                          sortDirection === "desc" && "rotate-180"
                        )} />
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayRows.map(({ row, originalIndex }) => {
                const isSelected = selectedRows.has(originalIndex);
                return (
                  <tr 
                    key={originalIndex}
                    className={cn(
                      "hover:bg-muted/30 transition-colors cursor-pointer",
                      isSelected && "bg-primary/10"
                    )}
                    onClick={() => handleRowSelect(originalIndex)}
                  >
                    <td className="px-2 py-1.5 border-b border-r text-center sticky left-0 bg-background z-10">
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => handleRowSelect(originalIndex)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td className="px-2 py-1.5 border-b border-r text-center text-muted-foreground text-xs sticky left-10 bg-background z-10">
                      {originalIndex + 1}
                    </td>
                    {headers.map((_, colIdx) => (
                      <td 
                        key={colIdx}
                        className="px-3 py-1.5 border-b border-r max-w-[200px] truncate"
                        title={String(row[colIdx] ?? "")}
                      >
                        {row[colIdx] === null || row[colIdx] === undefined ? (
                          <span className="text-muted-foreground italic">null</span>
                        ) : (
                          String(row[colIdx])
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination Controls */}
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2">
          <Label className="text-muted-foreground">Rows per page:</Label>
          <Select value={String(pageSize)} onValueChange={handlePageSizeChange}>
            <SelectTrigger className="w-20 h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map(size => (
                <SelectItem key={size} value={String(size)}>{size}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="text-muted-foreground">
          Showing {startIndex + 1}-{endIndex} of {filteredRows.length} rows
          {filterText && ` (filtered from ${dataRows.length})`}
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setCurrentPage(0)}
            disabled={currentPage === 0}
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setCurrentPage(p => Math.max(0, p - 1))}
            disabled={currentPage === 0}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="px-2 text-muted-foreground">
            Page {currentPage + 1} of {totalPages || 1}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setCurrentPage(p => Math.min(totalPages - 1, p + 1))}
            disabled={currentPage >= totalPages - 1}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setCurrentPage(totalPages - 1)}
            disabled={currentPage >= totalPages - 1}
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PLANS = [
  { value: "free", label: "Shared Schema (Free)", enabled: true },
  { value: "basic_256mb", label: "Shared Schema (Default)", enabled: true },
];

const REGIONS = [
  { value: "canadacentral", label: "Canada Central" },
  { value: "canadaeast", label: "Canada East" },
  { value: "eastus", label: "East US" },
  { value: "eastus2", label: "East US 2" },
  { value: "westus", label: "West US" },
  { value: "westeurope", label: "West Europe" },
];

const POSTGRES_VERSIONS = [
  { value: "16", label: "PostgreSQL 16" },
  { value: "15", label: "PostgreSQL 15" },
  { value: "14", label: "PostgreSQL 14" },
];

interface DatabaseConfigurationFieldsForm {
  plan: string;
  region: string;
  postgresVersion: string;
}

interface DatabaseConfigurationFieldsProps {
  form: DatabaseConfigurationFieldsForm;
  mode: "create" | "edit";
  database?: {
    render_postgres_id?: unknown;
  };
  onPlanChange: (value: string) => void;
  onRegionChange: (value: string) => void;
  onPostgresVersionChange: (value: string) => void;
}

/**
 * Renders database plan, region, and PostgreSQL version controls.
 *
 * @example
 * <DatabaseConfigurationFields
 *   form={form}
 *   mode={mode}
 *   database={database}
 *   onPlanChange={(value) => setForm({ ...form, plan: value })}
 *   onRegionChange={(value) => setForm({ ...form, region: value })}
 *   onPostgresVersionChange={(value) => setForm({ ...form, postgresVersion: value })}
 * />
 */
export function DatabaseConfigurationFields({
  form,
  mode,
  database,
  onPlanChange,
  onRegionChange,
  onPostgresVersionChange,
}: DatabaseConfigurationFieldsProps) {
  const isRenderPostgresEdit = mode === "edit" && Boolean(database?.render_postgres_id);

  const handlePlanChange = (value: string) => {
    if (!PLANS.some((plan) => plan.value === value && plan.enabled)) {
      return;
    }

    onPlanChange(value);
  };

  const handleRegionChange = (value: string) => {
    if (!REGIONS.some((region) => region.value === value)) {
      return;
    }

    onRegionChange(value);
  };

  const handlePostgresVersionChange = (value: string) => {
    if (!POSTGRES_VERSIONS.some((version) => version.value === value)) {
      return;
    }

    onPostgresVersionChange(value);
  };

  return (
    <>
      <div className="space-y-2">
        <Label>Plan</Label>
        <Select value={form.plan} onValueChange={handlePlanChange}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-64">
            {PLANS.map((plan) => (
              <SelectItem
                key={plan.value}
                value={plan.value}
                disabled={!plan.enabled}
              >
                {plan.label}
                {!plan.enabled && " (Coming soon)"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>Region</Label>
        <Select
          value={form.region}
          onValueChange={handleRegionChange}
          disabled={isRenderPostgresEdit}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REGIONS.map((region) => (
              <SelectItem key={region.value} value={region.value}>
                {region.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>PostgreSQL Version</Label>
        <Select
          value={form.postgresVersion}
          onValueChange={handlePostgresVersionChange}
          disabled={isRenderPostgresEdit}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {POSTGRES_VERSIONS.map((version) => (
              <SelectItem key={version.value} value={version.value}>
                {version.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}

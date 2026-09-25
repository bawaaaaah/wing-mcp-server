import type { JSX } from "react";
import type { HealthStatus } from "../api/queries.js";

const LABELS: Record<HealthStatus, string> = {
  HEALTHY: "Healthy",
  DEGRADED: "Degraded",
  ERROR: "Error",
};

export function HealthBadge({ status }: { status: HealthStatus }): JSX.Element {
  return (
    <span className={"health-badge health-badge--" + status.toLowerCase()}>
      <span className="health-badge__dot" />
      {LABELS[status] ?? status}
    </span>
  );
}

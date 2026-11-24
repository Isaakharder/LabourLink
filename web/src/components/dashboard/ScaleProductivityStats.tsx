import { DashboardScaleProductivity } from "../../lib/dashboardTypes";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// kg/hour for a Job measured with LabourLink Scale: weighed, credited bins
// divided by the picking time matched to those same bins. The server decides
// every figure; this only renders it.
export function ScaleProductivityStats({ scale }: { scale: DashboardScaleProductivity }) {
  return (
    <>
      <dt>This week</dt>
      <dd>{scale.kgPerHour != null ? `${scale.kgPerHour.toFixed(1)} kg/hour` : "Waiting for weighed bins"}</dd>
      <dt>Weighed bins</dt>
      <dd>
        {scale.weighedBins > 0
          ? `${scale.netKg.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg · ${scale.matchedHours.toFixed(2)} h picking · ${plural(scale.weighedBins, "bin")}`
          : "None yet"}
      </dd>
      {(scale.binsNotYetWeighed > 0 || scale.excludedBins > 0) && (
        <>
          <dt>Not counted yet</dt>
          <dd>
            {[
              scale.binsNotYetWeighed > 0 ? `${plural(scale.binsNotYetWeighed, "bin")} not weighed yet` : null,
              scale.excludedBins > 0 ? `${plural(scale.excludedBins, "bin")} to review` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </dd>
        </>
      )}
    </>
  );
}

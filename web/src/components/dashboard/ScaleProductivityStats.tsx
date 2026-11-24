import { DashboardScaleProductivity } from "../../lib/dashboardTypes";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const kg = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });

// kg/hour for a Job measured with LabourLink Scale: weighed, credited bins
// divided by the picking time matched to those same bins. A bin several
// employees picked into is shared by their picking minutes; those kilograms
// are an estimate and are labelled so. The server decides every figure; this
// only renders it.
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
      {((scale.sharedBins ?? 0) > 0 || (scale.manualKg ?? 0) > 0) && (
        <>
          <dt>Shared bins</dt>
          <dd>
            {[
              (scale.sharedBins ?? 0) > 0 ? `${plural(scale.sharedBins ?? 0, "shared bin")}` : null,
              (scale.estimatedKg ?? 0) > 0 ? `${kg(scale.estimatedKg ?? 0)} kg estimated from picking minutes` : null,
              (scale.manualKg ?? 0) > 0 ? `${kg(scale.manualKg ?? 0)} kg set by an administrator` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </dd>
        </>
      )}
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

import { Language, t } from "../../lib/i18n";

export interface RecentJob {
  id: string;
  activityId: string;
  name: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  row: { label: string } | null;
  carrier: { label: string } | null;
  // Closed by the server-side daily-cutoff safety net (a forgotten End
  // Work carried past local midnight) rather than a real tap.
  autoClosed: boolean;
}

interface RecentJobsCardProps {
  jobs: RecentJob[];
  language: Language;
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return hours >= 1 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function RecentJobsCard({ jobs, language }: RecentJobsCardProps) {
  return (
    <div className="recent-jobs-card">
      <h3 className="recent-jobs-title">{t(language, "recentJobs")}</h3>
      {jobs.length === 0 ? (
        <p className="recent-jobs-empty">{t(language, "noRecentJobs")}</p>
      ) : (
        <ul className="recent-jobs-list">
          {jobs.map((job) => (
            <li key={job.id} className="recent-jobs-item">
              <span className="recent-jobs-item-name">{job.name}</span>
              {job.row && <span className="recent-jobs-item-row">{job.row.label}</span>}
              {job.carrier && <span className="recent-jobs-item-row">{job.carrier.label}</span>}
              <span className="recent-jobs-item-meta">
                {formatTime(job.startedAt)} – {formatTime(job.endedAt)} · {formatDuration(job.durationSeconds)}
                {job.autoClosed && (
                  <span className="recent-jobs-item-autoclosed"> · {t(language, "autoClosedSuffix")}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

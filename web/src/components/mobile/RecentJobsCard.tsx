export interface RecentJob {
  id: string;
  activityId: string;
  name: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
}

interface RecentJobsCardProps {
  jobs: RecentJob[];
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

export function RecentJobsCard({ jobs }: RecentJobsCardProps) {
  return (
    <div className="recent-jobs-card">
      <h3 className="recent-jobs-title">Recent jobs</h3>
      {jobs.length === 0 ? (
        <p className="recent-jobs-empty">No recent jobs yet.</p>
      ) : (
        <ul className="recent-jobs-list">
          {jobs.map((job) => (
            <li key={job.id} className="recent-jobs-item">
              <span className="recent-jobs-item-name">{job.name}</span>
              <span className="recent-jobs-item-meta">
                {formatTime(job.startedAt)} – {formatTime(job.endedAt)} · {formatDuration(job.durationSeconds)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

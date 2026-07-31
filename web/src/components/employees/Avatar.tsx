import { useEffect, useState } from "react";

interface AvatarProps {
  photoUrl?: string | null;
  firstName: string;
  lastName: string;
  size?: "small" | "large";
}

function initials(firstName: string, lastName: string): string {
  const a = firstName.trim().charAt(0).toUpperCase();
  const b = lastName.trim().charAt(0).toUpperCase();
  return a + b || "?";
}

export function Avatar({ photoUrl, firstName, lastName, size = "small" }: AvatarProps) {
  const [failed, setFailed] = useState(false);

  // A replaced photo gets a new URL — give it a fresh chance to load rather
  // than staying stuck on a previous failure.
  useEffect(() => setFailed(false), [photoUrl]);

  const showImage = Boolean(photoUrl) && !failed;

  return (
    <div className={`avatar avatar-${size}`}>
      {showImage ? (
        <img src={photoUrl!} alt={`${firstName} ${lastName}`} onError={() => setFailed(true)} />
      ) : (
        <span className="avatar-initials">{initials(firstName, lastName)}</span>
      )}
    </div>
  );
}

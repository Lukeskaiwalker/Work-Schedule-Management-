import { useState, useEffect } from "react";

export function threadInitials(name: string) {
  const parts = (name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "T";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

export function ThreadIconBadge({
  threadId,
  initials,
  hasIcon,
  versionKey,
  className,
}: {
  threadId: number;
  initials: string;
  hasIcon: boolean;
  versionKey: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const classNames = className ? `thread-avatar ${className}` : "thread-avatar";

  useEffect(() => {
    setFailed(false);
  }, [threadId, hasIcon, versionKey]);

  return (
    <div className={classNames} aria-hidden="true">
      {hasIcon && !failed && (
        <img
          src={`/api/threads/${threadId}/icon?v=${encodeURIComponent(versionKey)}`}
          alt=""
          onError={() => setFailed(true)}
        />
      )}
      <span>{initials}</span>
    </div>
  );
}

import { useState, useEffect } from "react";

export function AvatarBadge({
  userId,
  initials,
  hasAvatar,
  versionKey,
  className,
}: {
  userId: number;
  initials: string;
  hasAvatar: boolean;
  versionKey: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const classNames = className ? `sidebar-user-avatar ${className}` : "sidebar-user-avatar";

  useEffect(() => {
    setFailed(false);
  }, [userId, hasAvatar, versionKey]);

  return (
    <div className={classNames} aria-hidden="true">
      {hasAvatar && !failed && (
        <img
          src={`/api/users/${userId}/avatar?v=${encodeURIComponent(versionKey)}`}
          alt=""
          onError={() => setFailed(true)}
        />
      )}
      <span>{initials}</span>
    </div>
  );
}

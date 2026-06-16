import { FC, ReactNode } from 'react';

// Shared page-title header. Matches V2Portfolio's `.pfx-title` typography
// (Orbitron 800 / 16px + Sora 9px muted subtitle) so every primary page
// reads as one family. Styles live in App.css under `.v2-pagehead`.
export const V2PageHeader: FC<{ title: string; subtitle?: string; right?: ReactNode }> = ({
  title, subtitle, right,
}) => (
  <div className="v2-pagehead">
    <div className="ph-title">{title}{subtitle ? <span>{subtitle}</span> : null}</div>
    {right ?? null}
  </div>
);

export default V2PageHeader;

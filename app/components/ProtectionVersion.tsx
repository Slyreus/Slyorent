import { ExternalLink, Info } from "lucide-react";

type ProtectionVersionProps = {
  version: string;
  electron?: string;
  chromium?: string;
  media?: string;
  onOpenReleasePage: () => void;
};

export function ProtectionVersion({ version, electron, chromium, media, onOpenReleasePage }: ProtectionVersionProps) {
  const components = [
    electron && `Electron ${electron}`,
    chromium && `Chromium ${chromium}`,
    media && `FFmpeg ${media}`,
  ].filter(Boolean).join(" · ");

  return (
    <section className="panel protection-version" aria-label="Version installée">
      <span className="security-icon blue"><Info size={20} /></span>
      <div>
        <h2>Slyorrent {version}</h2>
        {components && <p>{components}</p>}
      </div>
      <button type="button" className="secondary-button" onClick={onOpenReleasePage}>
        <ExternalLink size={15} /> Versions GitHub
      </button>
    </section>
  );
}

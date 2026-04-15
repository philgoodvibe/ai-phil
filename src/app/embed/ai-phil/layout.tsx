/**
 * Embed route layout.
 * Removes all page chrome — meant to render a single widget that
 * fills the iframe viewport.
 */

export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-[#0a1928]">
      {children}
    </div>
  );
}

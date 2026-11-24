/**
 * A page that is one table. It is as tall as the page and no taller: the table scrolls
 * within it, under a header that stays.
 */
export function TablePage({ children }: { children: React.ReactNode }) {
  return (
    <div className="aperture:flex aperture:h-full aperture:min-h-0 aperture:min-w-0 aperture:flex-col aperture:gap-2 aperture:p-3">
      {children}
    </div>
  );
}

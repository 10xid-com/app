import Link from "next/link";
import { Icon } from "../_components/icons";

/** The note by Save and add another that "Add new product" goes to on an item still open (review-form.tsx). */
export const FINISH_FIRST = "finish-this-item";

/**
 * "Add new product", right beside Inventory in the top bar of the inventory
 * pages, for whoever may add to it (inventory.write — the page has checked
 * that, and that Inventory is on for this business, before passing it in).
 *
 * It starts nothing itself. Anywhere but an item being catalogued it opens
 * /inventory/capture, which only reads: its Start button, and the items
 * started and not saved, to carry on with. On an item being catalogued it
 * stays on that item and goes to the note by Save and add another — finish
 * this one, or discard it, before the next — so nothing taken or typed is left
 * behind by a tap.
 */
export function AddNewProduct({ finishFirst = false }: { finishFirst?: boolean }) {
  const label = (
    <>
      <Icon name="plus" className="hidden h-4 w-4 sm:block" />
      Add new product
    </>
  );
  return finishFirst ? (
    // The browser's own jump to a fragment, not <Link>: it scrolls the note into
    // view, moves focus to it, and shows it (:target) without touching the form.
    <a href={`#${FINISH_FIRST}`} className={button}>
      {label}
    </a>
  ) : (
    <Link href="/inventory/capture" className={button}>
      {label}
    </Link>
  );
}

// A little tighter on a phone, so Inventory beside it is never cut short.
const button =
  "inline-flex min-h-9 flex-none items-center gap-1.5 whitespace-nowrap rounded-lg bg-brand-surface px-2.5 text-[13px] font-[600] sm:px-3 sm:text-[14px] " +
  "text-brand-on-surface shadow-card transition-colors hover:bg-brand-surface-hover " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

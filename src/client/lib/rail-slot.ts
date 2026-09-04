import { createContext } from 'react';

// The app shell owns the layout row (sidebar · main · rail); a page that
// wants a full-height right rail portals into this slot. Null until the
// shell's slot element mounts — one extra render, no layout flash.
export const RailSlotContext = createContext<HTMLElement | null>(null);

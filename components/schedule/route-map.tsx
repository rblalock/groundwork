"use client";

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import type { MapMarker, MapPoints } from "@/lib/route-map";

// The Route view's map (Leaflet over OpenStreetMap tiles, no key). It only draws what `mapPoints` worked out
// from the server's plans; a stop's marker opens the visit's details like its row in the list. Loaded in the
// browser only (`next/dynamic` without SSR), since Leaflet needs the window.

const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// Lucide's house, drawn in the marker so the yard reads as home.
const HOUSE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

const yardIcon = L.divIcon({
  className: "",
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  html: `<span class="flex size-7 items-center justify-center rounded-full bg-ink text-canvas shadow-card ring-2 ring-surface">${HOUSE}</span>`,
});

/** A stop: its number in the crew member's color; ringed in the warning color when late, larger when open. */
function stopIcon(marker: MapMarker, selected: boolean): L.DivIcon {
  const size = selected ? 30 : 24;
  const ring = marker.warn ? "0 0 0 2px var(--surface), 0 0 0 4px var(--orange)" : selected ? "0 0 0 2px var(--surface), 0 0 0 4px var(--accent)" : "0 0 0 2px var(--surface)";
  return L.divIcon({
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<span class="flex items-center justify-center rounded-full text-[12px] font-semibold text-white tabular-nums" style="width:${size}px;height:${size}px;background:${marker.color};box-shadow:${ring};opacity:${marker.done ? 0.55 : 1}">${marker.number}</span>`,
  });
}

export function RouteMap({
  points,
  label,
  yardLabel,
  selectedId,
  onStop,
}: {
  points: MapPoints;
  /** The map's name for screen readers. */
  label: string;
  yardLabel: string;
  selectedId: string | null;
  onStop: (visitId: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<L.LayerGroup | null>(null);
  const onStopRef = useRef(onStop);
  useEffect(() => {
    onStopRef.current = onStop;
  }, [onStop]);

  useEffect(() => {
    if (!box.current) return;
    const created = L.map(box.current, { scrollWheelZoom: false });
    L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(created);
    layers.current = L.layerGroup().addTo(created);
    map.current = created;
    // The box is shorter on phones; Leaflet re-measures when it changes.
    const resize = new ResizeObserver(() => created.invalidateSize());
    resize.observe(box.current);
    return () => {
      resize.disconnect();
      created.remove();
      map.current = null;
      layers.current = null;
    };
  }, []);

  useEffect(() => {
    const group = layers.current;
    if (!group) return;
    group.clearLayers();
    for (const line of points.lines) {
      L.polyline(line.points, {
        color: line.color,
        weight: line.dashed ? 2 : 3,
        opacity: line.dashed ? 0.75 : 0.9,
        dashArray: line.dashed ? "6 6" : undefined,
        interactive: false,
      }).addTo(group);
    }
    if (points.yard) {
      L.marker(points.yard.at, { icon: yardIcon, title: `${yardLabel}: ${points.yard.label}`, alt: yardLabel, keyboard: false, zIndexOffset: -1000 }).addTo(group);
    }
    for (const marker of points.markers) {
      const selected = marker.visitId === selectedId;
      L.marker(marker.at, { icon: stopIcon(marker, selected), title: `${marker.number}. ${marker.title}`, alt: marker.title, riseOnHover: true, zIndexOffset: selected ? 1000 : 0 })
        .on("click", () => onStopRef.current(marker.visitId))
        .addTo(group);
    }
  }, [points, selectedId, yardLabel]);

  // Fit to the day when its points change, not when a stop is opened.
  const bounds = JSON.stringify(points.bounds);
  useEffect(() => {
    const parsed = JSON.parse(bounds) as MapPoints["bounds"];
    if (!map.current || !parsed) return;
    const [southWest, northEast] = parsed;
    if (southWest[0] === northEast[0] && southWest[1] === northEast[1]) map.current.setView(southWest, 14);
    else map.current.fitBounds(parsed, { padding: [28, 28], maxZoom: 16 });
  }, [bounds]);

  // Its own stacking context, so Leaflet's high z-indexes stay under the page's dialogs.
  return <div aria-label={label} className="relative isolate z-0 h-60 w-full bg-inset sm:h-90" ref={box} role="region" />;
}

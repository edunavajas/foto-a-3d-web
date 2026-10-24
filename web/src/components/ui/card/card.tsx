"use client";

/* Vendored from uiarc.dev (MIT): https://uiarc.dev/r/card.json
   Adapted: the quick-look dialog (details/open/onOpenChange, Radix) is removed —
   this app only uses the presentational surface. Everything else is upstream. */

import { useEffect, useId, useRef, useState } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { HTMLMotionProps, MotionProps, Variants } from "motion/react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./card.module.css";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  title: string;
  description?: string;
  media?: ReactNode;
  action?: ReactNode;
  /** A small leading visual for the footer, such as the owner's avatar. */
  avatar?: ReactNode;
  /** Who the card belongs to, such as the owner's name. */
  meta?: ReactNode;
  /** A short status under the meta, such as "Updated 2 hours ago". Changed words rise in and are announced politely. */
  status?: string;
}

const { blur, duration, ease, stagger } = motionTokens;
const fade = { duration: duration.instant };
/** The photo drifts in slowly while the card is pointed at, and eases back a little faster. */
const ZOOM = 1.04;
const zoomIn: MotionProps["transition"] = { duration: duration.considered * 2, ease: [...ease.standard] };
const zoomOut: MotionProps["transition"] = { duration: duration.considered, ease: [...ease.standard] };

/** A new status replaces the whole line: the old one lifts away quickly while the new words rise in one after another. */
const lineMotion: Variants = {
  enter: {},
  center: {},
  exit: { opacity: 0, y: "-.3em", filter: `blur(${blur.subtle}px)`, transition: { duration: duration.fast, ease: [...ease.standard] } },
};
const wordMotion: Variants = {
  enter: { opacity: 0, y: ".3em", filter: `blur(${blur.soft}px)` },
  center: (order: number) => ({ opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: duration.standard, ease: [...ease.enter], delay: order * stagger.word } }),
};

function Status({ text, reduced }: { text: string; reduced: boolean }) {
  return <span className={styles.status} role="status">
    <span className={styles.srOnly}>{text}</span>
    <span className={styles.roll} aria-hidden="true"><AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={text} className={styles.line} variants={lineMotion} initial={reduced ? false : "enter"} animate="center" exit={reduced ? undefined : "exit"}>
        {text.split(/(\s+)/).map((part, index) => <motion.span key={index} className={styles.word} custom={index / 2} variants={wordMotion}>{part}</motion.span>)}
      </motion.span>
    </AnimatePresence></span>
  </span>;
}

export function Card({ title, description, media, action, avatar, meta, status, children, className, style, ...props }: CardProps) {
  const reduced = useReducedMotion() ?? false;
  useId(); // Stable identity hook kept for parity with upstream internals.
  const cardRef = useRef<HTMLElement>(null);
  const [hovered, setHovered] = useState(false);

  const footer = avatar || meta || status || action ? <div className={styles.footer}>
    {avatar || meta || status ? <div className={styles.byline}>
      {avatar ? <span className={styles.avatar}>{avatar}</span> : null}
      <span className={styles.bylineText}>{meta ? <span className={styles.meta}>{meta}</span> : null}{status ? <Status text={status} reduced={reduced} /> : null}</span>
    </div> : null}
    {action ? <div className={styles.action}>{action}</div> : null}
  </div> : null;

  return <motion.article
    {...(props as HTMLMotionProps<"article">)}
    ref={cardRef}
    className={[styles.card, className].filter(Boolean).join(" ")}
    style={style}
    data-hover={hovered || undefined}
    whileHover={reduced ? undefined : { y: -2 }}
    onHoverStart={() => setHovered(true)}
    onHoverEnd={() => setHovered(false)}
    transition={{ default: motionTokens.spring.snappy }}
  >
    {media ? <div className={styles.media}><motion.div className={styles.zoom} initial={false} animate={{ scale: hovered && !reduced ? ZOOM : 1 }} transition={hovered ? zoomIn : zoomOut}>{media}</motion.div></div> : null}
    <div className={styles.content}>
      <h3 className={styles.title}>{title}</h3>
      {description ? <p className={styles.description}>{description}</p> : null}
      {children}
      {footer}
    </div>
  </motion.article>;
}

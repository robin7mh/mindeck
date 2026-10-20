import { useMemo, type HTMLAttributes } from 'react'
import { renderMarkdown } from '@/features/memory/markdown'
import { cn } from '@/lib/cn'
import { interceptLinks } from '@/lib/links'

type Props = { text: string } & Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'dangerouslySetInnerHTML'>

/**
 * Markdown from anywhere (PRs, agent answers, notebooks, READMEs), through the
 * one sanitizer. A click on a link never navigates Mindeck itself: web and
 * mail addresses open outside, unless the view brings its own `onClick`.
 */
export function Markdown({ text, className, onClick, ...rest }: Props) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div {...rest} className={cn('md-prose', className)} onClick={onClick ?? interceptLinks} dangerouslySetInnerHTML={{ __html: html }} />
}

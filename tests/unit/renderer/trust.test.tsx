import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, installBridge, settle } from './bridge'
import type { Project } from '@shared/types/project'
import { TrustBanner } from '@/features/editor/components/TrustBanner'
import { useProjects } from '@/features/projects/store'
import { useLanguages } from '@/features/editor/languages'
import { useLintStatus } from '@/features/editor/lintStatus'
import { useScm } from '@/features/editor/scm'
import { useSftp } from '@/features/editor/sftp'
import { de } from '@/lib/i18n/de'
import { en } from '@/lib/i18n/en'

const project = (over: Partial<Project> = {}): Project => ({ id: 'p', name: 'demo', path: '/code/demo', addedAt: '', lastSeenAt: '', trusted: false, ...over })

beforeEach(() => {
  useProjects.setState({ projects: [project(), project({ id: 'other', name: 'other' })], error: undefined })
})

describe('workspace trust in the editor', () => {
  it('a restricted project shows the banner; trusting it lets the editor ask its tools again', async () => {
    const trusted = vi.fn(({ id }: { id: string }) => project({ id, trusted: true }))
    installBridge({ 'projects:trust': trusted })
    const restart = vi.fn(async () => {})
    useLintStatus.setState({ restart })
    const refresh = vi.spyOn(useScm.getState(), 'refresh').mockResolvedValue()
    const load = vi.spyOn(useSftp.getState(), 'load').mockResolvedValue()
    const tools = useLanguages.getState().toolsVersion

    const { rerender } = render(<TrustBanner project={useProjects.getState().projects[0]} />)
    expect(screen.getByRole('alert').textContent).toContain(en.trust.restricted('demo'))
    fireEvent.click(screen.getByRole('button', { name: en.trust.trust }))
    expect(screen.getByRole('button', { name: en.trust.trusting })).toHaveProperty('disabled', true)
    await act(() => settle())
    expect(trusted).toHaveBeenCalledWith({ id: 'p', trusted: true })
    expect(useProjects.getState().projects.map((p) => p.trusted)).toEqual([true, false])
    expect(useLanguages.getState().toolsVersion).toBe(tools + 1)
    expect(restart).toHaveBeenCalled()
    expect(refresh).toHaveBeenCalled()
    expect(load).toHaveBeenCalled()

    rerender(<TrustBanner project={useProjects.getState().projects[0]} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a refusal (a member device may not trust) shows in the banner; nothing else changes', async () => {
    installBridge({ 'projects:trust': () => fail('Admins only', 'admin-only') })
    render(<TrustBanner project={project()} />)
    fireEvent.click(screen.getByRole('button', { name: en.trust.trust }))
    await act(() => settle())
    expect(screen.getByText('Admins only')).toBeTruthy()
    expect(useProjects.getState().projects[0].trusted).toBe(false)
    expect(await useProjects.getState().trust('p')).toBe('Admins only')
  })

  it('speaks German too', () => {
    expect(de.trust.restricted('demo')).toContain('demo')
    expect(de.trust.trust).toBe('Diesem Projekt vertrauen')
    expect(de.trust.trusting).toBeTruthy()
  })
})

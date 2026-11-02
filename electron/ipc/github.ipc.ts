import type { Router } from './router'
import type { GitHubService } from '../main/services/github/GitHubService'

/** Binds the github:* channels (pull requests through the user's gh) to GitHubService. */
export function registerGitHubIpc(router: Router, service: GitHubService): void {
  router.register('github:status', ({ projectId }) => service.status(projectId))
  router.register('github:list', ({ projectId, filter, state }) => service.list(projectId, filter, state))
  router.register('github:view', ({ projectId, number }) => service.view(projectId, number))
  router.register('github:fileDiff', ({ projectId, number, path }) => service.fileDiff(projectId, number, path))
  router.register('github:checkout', ({ projectId, number }) => service.checkout(projectId, number))
  router.register('github:create', ({ projectId, ...pr }) => service.create(projectId, pr))
  router.register('github:merge', ({ projectId, number, method, deleteBranch }) => service.merge(projectId, number, method, deleteBranch))
  router.register('github:comment', ({ projectId, number, body }) => service.comment(projectId, number, body))
  router.register('github:review', ({ projectId, number, action, body }) => service.review(projectId, number, action, body))
  router.register('github:owners', ({ projectId }) => service.owners(projectId))
  router.register('github:publish', ({ projectId, ...repo }) => service.publish(projectId, repo))
}

/**
 * Marker carried only by Azure DevOps request-changes findings comments.
 *
 * An Azure DevOps reviewer's verdict is a *vote* on the pull request, and a vote
 * change reaches a service hook as a plain `git.pullrequest.updated` carrying no
 * structured "what changed" field — so, as on GitLab, the findings comment is the
 * observable verdict. Ingress recognizes this provider-local marker and maps the
 * comment back onto the neutral review event that wakes Respond-to-review.
 */

import { swarmMarker } from '../../../scm/swarm-origin.js';

const REQUEST_CHANGES_MARKER_KIND = 'azure-devops-request-changes';
const REQUEST_CHANGES_MARKER_PREFIX = `<!-- swarm-${REQUEST_CHANGES_MARKER_KIND}:`;

export function azureDevOpsRequestChangesMarker(deliveryId: string): string {
	return swarmMarker(REQUEST_CHANGES_MARKER_KIND, deliveryId);
}

export function isAzureDevOpsRequestChangesMarker(body: string | undefined): boolean {
	return body?.includes(REQUEST_CHANGES_MARKER_PREFIX) ?? false;
}

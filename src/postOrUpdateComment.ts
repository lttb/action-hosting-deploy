/**
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { endGroup, startGroup } from "@actions/core";
import type { GitHub } from "@actions/github/lib/utils";
import { Context } from "@actions/github/lib/context";
import {
  ChannelSuccessResult,
  interpretChannelDeployResult,
  ErrorResult,
} from "./deploy";
import { createDeploySignature } from "./hash";

const PERSISTENT_SIGNATURE = "65f014ba-2d77-4f11-bbac-0117b42f907b";

export function createBotCommentIdentifier(signature: string) {
  return function isCommentByBot(comment): boolean {
    return comment.user.type === "Bot" && comment.body.includes(signature);
  };
}

export function getURLsMarkdownFromChannelDeployResult(
  result: ChannelSuccessResult
): string {
  const { urls } = interpretChannelDeployResult(result);

  return urls.length === 1
    ? `[${urls[0]}](${urls[0]})`
    : urls.map((url) => `- [${url}](${url})`).join("\n");
}

export function getChannelDeploySuccessComment(
  results: { deployment: ChannelSuccessResult; pkg: string }[],
  commit: string
) {
  return `
Visit the preview URL for this PR (updated for commit ${commit}):

${results
  .map(({ deployment, pkg }) => {
    const deploySignature = createDeploySignature(deployment);
    const urlList = getURLsMarkdownFromChannelDeployResult(deployment);
    const { expireTime } = interpretChannelDeployResult(deployment);

    return `
**${pkg}**
${urlList}
<sub>(expires ${new Date(expireTime).toUTCString()})</sub>
<sub>Sign: ${deploySignature}</sub>
  `;
  })
  .join("\n")}

<sub>id: ${PERSISTENT_SIGNATURE}</sub>

`.trim();
}

export async function postChannelSuccessComment(
  github: InstanceType<typeof GitHub>,
  context: Context,
  results: { deployment: ChannelSuccessResult; pkg: string }[],
  commit: string
) {
  const commentInfo = {
    ...context.repo,
    issue_number: context.issue.number,
  };

  const commentMarkdown = getChannelDeploySuccessComment(results, commit);

  const comment = {
    ...commentInfo,
    body: commentMarkdown,
  };

  startGroup(`Commenting on PR`);
  const isCommentByBot = createBotCommentIdentifier(PERSISTENT_SIGNATURE);

  let commentId;
  try {
    const comments = (await github.rest.issues.listComments(commentInfo)).data;
    for (let i = comments.length; i--; ) {
      const c = comments[i];
      if (isCommentByBot(c)) {
        commentId = c.id;
        break;
      }
    }
  } catch (e) {
    console.log("Error checking for previous comments: " + e.message);
  }

  if (commentId) {
    try {
      await github.rest.issues.updateComment({
        ...context.repo,
        comment_id: commentId,
        body: comment.body,
      });
    } catch (e) {
      commentId = null;
    }
  }

  if (!commentId) {
    try {
      await github.rest.issues.createComment(comment);
    } catch (e) {
      console.log(`Error creating comment: ${e.message}`);
    }
  }
  endGroup();
}

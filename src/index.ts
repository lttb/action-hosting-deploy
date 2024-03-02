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

import {
  endGroup,
  getInput,
  setFailed,
  setOutput,
  startGroup,
} from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { existsSync } from "fs";
import { createCheck } from "./createCheck";
import { createGacFile } from "./createGACFile";
import {
  ChannelSuccessResult,
  deployPreview,
  deployProductionSite,
  ErrorResult,
  interpretChannelDeployResult,
  type ProductionSuccessResult,
} from "./deploy";
import { getChannelId } from "./getChannelId";
import {
  getURLsMarkdownFromChannelDeployResult,
  postChannelSuccessComment,
} from "./postOrUpdateComment";

// Inputs defined in action.yml
const expires = getInput("expires");
const projectId = getInput("projectId");
const googleApplicationCredentials = getInput("firebaseServiceAccount", {
  required: true,
});
const configuredChannelId = getInput("channelId");
const isProductionDeploy = configuredChannelId === "live";
const token = process.env.GITHUB_TOKEN || getInput("repoToken");
const octokit = token ? getOctokit(token) : undefined;
const singleEntryPoint = getInput("entryPoint");
const target = getInput("target");
const firebaseToolsVersion = getInput("firebaseToolsVersion");

const packages = getInput("packages");
const entryPointTemplate = getInput("entryPointTemplate");

async function run(pkgs: string[]) {
  const isPullRequest = !!context.payload.pull_request;

  try {
    startGroup("Setting up CLI credentials");
    const gacFilename = await createGacFile(googleApplicationCredentials);
    console.log(
      "Created a temporary file with Application Default Credentials."
    );
    endGroup();

    const deployments = await Promise.all(
      pkgs.map(async (pkg) => {
        let finish = (details: Object) => console.log(details);
        if (token && isPullRequest) {
          finish = await createCheck(octokit, context);
        }

        try {
          if (isProductionDeploy) {
            startGroup(`Deploying to production site: "${pkg}"`);

            const deployment = await deployProductionSite(gacFilename, pkg, {
              projectId,
              target,
              firebaseToolsVersion,
            });
            if (deployment.status === "error") {
              throw Error((deployment as ErrorResult).error);
            }
            endGroup();

            const hostname = target
              ? `${target}.web.app`
              : `${projectId}.web.app`;
            const url = `https://${hostname}/`;
            await finish({
              details_url: url,
              conclusion: "success",
              output: {
                title: `Production deploy succeeded`,
                summary: `[${hostname}](${url})`,
              },
            });
            return deployment;
          }

          const channelId = getChannelId(configuredChannelId, context);

          startGroup(
            `Deploying to Firebase preview channel ${channelId}: "${pkg}"`
          );
          const deployment = await deployPreview(gacFilename, pkg, {
            projectId,
            expires,
            channelId,
            target,
            firebaseToolsVersion,
          });

          if (deployment.status === "error") {
            throw Error((deployment as ErrorResult).error);
          }
          endGroup();

          const { expireTime, urls } = interpretChannelDeployResult(deployment);

          setOutput("urls", urls);
          setOutput("expire_time", expireTime);
          setOutput("details_url", urls[0]);

          await finish({
            details_url: urls[0],
            conclusion: "success",
            output: {
              title: `Deploy preview succeeded`,
              summary: getURLsMarkdownFromChannelDeployResult(deployment),
            },
          });

          return deployment;
        } catch (e) {
          setFailed(e.message);

          await finish({
            conclusion: "failure",
            output: {
              title: "Deploy preview failed",
              summary: `Error: ${e.message}`,
            },
          });
        }
      })
    );

    if (token && isPullRequest && !!octokit) {
      const commitId = context.payload.pull_request?.head.sha.substring(0, 7);

      await postChannelSuccessComment(
        octokit,
        context,
        deployments as ChannelSuccessResult[],
        commitId
      );
    }
  } catch (e) {
    setFailed(e.message);
  }
}

if (packages) {
  run(
    JSON.parse(packages).map((pkg: string) =>
      entryPointTemplate.replace("$ENTRY_POINT", pkg)
    )
  );
} else {
  run([singleEntryPoint]);
}

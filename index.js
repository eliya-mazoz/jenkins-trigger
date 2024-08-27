const request = require('request');
const core = require('@actions/core');

let timer = setTimeout(() => {
  core.setFailed("Job Timeout");
  core.error("Exception Error: Timed out");
  }, (Number(core.getInput('timeout')) * 1000));

const sleep = (seconds) => {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, (seconds * 1000));
  });
};

async function triggerJenkinsJob(jobName, params, headers) {
  const jenkinsEndpoint = core.getInput('url');

  const jsonReq = {
    method: 'GET',
    url: `${jenkinsEndpoint}/job/${jobName}/api/json`,
    headers: headers
  };
  const isParameterized = await new Promise((resolve, reject) => 
    request(jsonReq, (err, res, body) => {
      if (err) {
        core.setFailed(err);
        core.error(JSON.stringify(err));
        clearTimeout(timer);
        reject();
      }
      resolve(body.search("ParametersDefinitionProperty") >= 0);
    })
  );
  const req = {
    method: 'POST',
    url: `${jenkinsEndpoint}/job/${jobName}${isParameterized ? '/buildWithParameters' : '/build'}`,
    form: isParameterized ? params : undefined,
    headers: headers
  };
  return new Promise((resolve, reject) =>
    request(req, (err, res) => {
      if (err) {
        core.setFailed(err);
        core.error(JSON.stringify(err));
        clearTimeout(timer);
        reject();
        return;
      }
      const location = res.headers['location'];
      if (!location) {
        const errorMessage = "Failed to find location header in response!";
        core.setFailed(errorMessage);
        core.error(errorMessage);
        clearTimeout(timer);
        reject();
        return;
      }

      resolve(location);
    })
  );
}

async function getJobStatus(jobName, statusUrl, headers) {
  if (!statusUrl.endsWith('/'))
    statusUrl += '/';

  const req = {
    method: 'GET',
    url: `${statusUrl}api/json`,
    headers: headers
  }

  return new Promise((resolve, reject) =>
      request(req, (err, res, body) => {
        if (err) {
          clearTimeout(timer);
          reject(err);
        }
        try {
        resolve(JSON.parse(body));
        } catch(err) {
          core.info(`Failed to parse body err: ${err}, body: ${body}`);
          resolve({timestamp: 0}); // try again
        }
      })
    );
}

async function waitJenkinsJob(jobName, timestamp, queueItemUrl, headers) {
  const sleepInterval = 5;
  let buildUrl = undefined
  core.info(`>>> Waiting for '${jobName}' ...`);
  while (true) {
    // check the queue until the job is assigned a build number
    if (!buildUrl) {
      let queueData = await getJobStatus(jobName, queueItemUrl, headers);

      if (queueData.cancelled)
        throw new Error(`Job '${jobName}' was cancelled.`);

      if (queueData.executable && queueData.executable.url) {
        buildUrl = queueData.executable.url;
        core.info(`>>> Job '${jobName}' started executing. BuildUrl=${buildUrl}`);
      }

      if (!buildUrl) {
        core.info(`>>> Job '${jobName}' is queued (Reason: '${queueData.why}'). Sleeping for ${sleepInterval}s...`);
        await sleep(sleepInterval);
        continue;
      }
    }
    let buildData = await getJobStatus(jobName, buildUrl, headers);
    core.info(`eliya test ${buildData.inProgress}`)
    if (getJobStatus.inProgress == false) {
      if (buildData.result == "SUCCESS") {
        core.info(`>>> Job '${buildData.fullDisplayName}' completed successfully with status ${buildData.result}!`);
        break;
      } else if (buildData.result == "FAILURE" || buildData.result == "ABORTED" || buildData.result == "UNSTABLE") {
        throw new Error(`Job '${buildData.fullDisplayName}' failed with status ${buildData.result}.`);
      }
    }

    core.info(`>>> Job '${buildData.fullDisplayName}' is executing (Duration: ${buildData.duration}ms, Expected: ${buildData.estimatedDuration}ms), Build still running. Sleeping for ${sleepInterval}s...`);
    await sleep(sleepInterval); // API call interval
  }
}

async function main() {
  try {
    // User input params
    let params = {};
    let startTs = + new Date();
    let jobName = core.getInput('job_name');
    if (core.getInput('parameter')) {
      params = JSON.parse(core.getInput('parameter'));
      core.info(`>>> Parameter ${params.toString()}`);
    }
    // create auth token for Jenkins API
    const API_TOKEN = Buffer.from(`${core.getInput('user_name')}:${core.getInput('api_token')}`).toString('base64');
    let headers = {
      'Authorization': `Basic ${API_TOKEN}`
    }
    if (core.getInput('headers')) {
      let user_headers = JSON.parse(core.getInput('headers'));
      headers = {
        ...headers,
        ...user_headers
      }
    }
    
    // POST API call
    let queueItemUrl = await triggerJenkinsJob(jobName, params, headers);

    // Waiting for job completion
    if (core.getInput('wait') == 'true') {
      await waitJenkinsJob(jobName, startTs, queueItemUrl, headers);
    }
  } catch (err) {
    core.setFailed(err.message);
    core.error(err.message);
  } finally {
    clearTimeout(timer);
  }
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED="0";
main();

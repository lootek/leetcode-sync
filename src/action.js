const axios = require('axios');
const {Octokit} = require('@octokit/rest');

const COMMIT_MESSAGE = '[Add LeetCode submission]';
const LANG_TO_EXTENSION = {
    'bash': 'sh',
    'c': 'c',
    'cpp': 'cpp',
    'csharp': 'cs',
    'dart': 'dart',
    'golang': 'go',
    'java': 'java',
    'javascript': 'js',
    'kotlin': 'kt',
    'mssql': 'sql',
    'mysql': 'sql',
    'oraclesql': 'sql',
    'php': 'php',
    'python': 'py',
    'python3': 'py',
    'ruby': 'rb',
    'rust': 'rs',
    'scala': 'scala',
    'swift': 'swift',
    'typescript': 'ts',
};

const delay = ms => new Promise(res => setTimeout(res, ms));

function log(message) {
    console.log(`[${new Date().toUTCString()}] ${message}`);
}

async function commit(params) {
    const {
        octokit,
        owner,
        repo,
        defaultBranch,
        commitInfo,
        treeSHA,
        latestCommitSHA,
        submission
    } = params;

    log(`Committing solution ${submission.id} for ${submission.title}...`);

    if (!LANG_TO_EXTENSION[submission.lang]) {
        throw `Language ${submission.lang} does not have a registered extension.`;
    }

    const path = `${submission.title}/solution_${submission.id}.${LANG_TO_EXTENSION[submission.lang]}`

    const treeData = [
        {
            path,
            mode: '100644',
            content: submission.code,
        }
    ];

    const treeResponse = await octokit.git.createTree({
        owner: owner,
        repo: repo,
        base_tree: treeSHA,
        tree: treeData,
    })

    const date = new Date(submission.timestamp * 1000).toISOString();
    const commitResponse = await octokit.git.createCommit({
        owner: owner,
        repo: repo,
        message: `${COMMIT_MESSAGE} - ${submission.title} (${submission.lang})`,
        tree: treeResponse.data.sha,
        parents: [latestCommitSHA],
        author: {
            email: commitInfo.email,
            name: commitInfo.name,
            date: date,
        },
        committer: {
            email: commitInfo.email,
            name: commitInfo.name,
            date: date,
        },
    })

    await octokit.git.updateRef({
        owner: owner,
        repo: repo,
        sha: commitResponse.data.sha,
        ref: 'heads/' + defaultBranch,
        force: true
    });

    log(`Committed solution ${submission.id} for ${submission.title}`);

    return [treeResponse.data.sha, commitResponse.data.sha];
}

// Returns false if no more submissions should be added.
function addToSubmissions(params) {
    const {
        response,
        details,
        submissions_dict,
        submissions
    } = params;

    for (const submission of response.data.submissions_dump) {
        if (submission.status !== 10) { // not accepted
            continue;
        }
        const name = submission.title;
        const lang = submission.lang;
        const timestamp = submission.timestamp;

        if (!submissions_dict[name]) {
            submissions_dict[name] = {};
        }

        if (!submissions_dict[name][lang]) {
            submissions_dict[name][lang] = {
                timestamp: timestamp,
                id: submission.id
            };
        }

        if (submissions_dict[name][lang].timestamp > timestamp) {
            continue // ignore older solutions
        }

        submissions_dict[name][lang] = {
            timestamp: timestamp,
            id: submission.id
        };
    }

    for (const s in submissions_dict) {
        for (const l in submissions_dict[s]) {
            submissions.push(submissions_dict[s][l].id);
        }
    }

    return true;
}

async function sync(inputs) {
    const {
        githubToken,
        owner,
        repo,
        leetcodeCSRFToken,
        leetcodeSession,
    } = inputs;

    const octokit = new Octokit({
        auth: githubToken,
        userAgent: 'LeetCode sync to GitHub - GitHub Action',
    });
    // First, get the time the timestamp for when the syncer last ran.
    const commits = await octokit.repos.listCommits({
        owner: owner,
        repo: repo,
        per_page: 100,
    });

    async function getSubmissionDetails(id) {
        const config = {
            headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRFToken': leetcodeCSRFToken,
                'Cookie': `csrftoken=${leetcodeCSRFToken};LEETCODE_SESSION=${leetcodeSession};`,
            }
        };

        const gql = {
            "operationName": "submissionDetails",
            "query": `query submissionDetails($submissionId: Int!) {
              submissionDetails(submissionId: $submissionId) {
                runtime
                runtimeDisplay
                runtimePercentile
                runtimeDistribution
                memory
                memoryDisplay
                memoryPercentile
                memoryDistribution
                code
                timestamp
                statusCode
                user {
                  username
                  profile {
                    realName
                    userAvatar
                  }
                }
                lang {
                  name
                  verboseName
                }
                question {
                  questionId
                }
                notes
                topicTags {
                  tagId
                  slug
                  name
                }
                runtimeError
                compileError
                lastTestcase
              }
            }`,
            "variables": {
                submissionId: id,
            }
        };

        return axios.post('https://leetcode.com/graphql', gql, config);
    }

    // commitInfo is used to get the original name / email to use for the author / committer.
    // Since we need to modify the commit time, we can't use the default settings for the
    // authenticated user.
    let commitInfo = commits.data[commits.data.length - 1].commit.author;
    for (const commit of commits.data) {
        if (!commit.commit.message.startsWith(COMMIT_MESSAGE)) {
            continue
        }
        commitInfo = commit.commit.author;
        break;
    }

    // Get all Accepted submissions from LeetCode greater than the timestamp.
    let response = null;
    let offset = 0;
    const submissions = [];
    const submissions_dict = {};
    do {
        const config = {
            params: {
                offset: offset,
                limit: 20,
                lastkey: (response === null ? '' : response.data.last_key),
            },
            headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRFToken': leetcodeCSRFToken,
                'Cookie': `csrftoken=${leetcodeCSRFToken};LEETCODE_SESSION=${leetcodeSession};`,
            },
        };
        log(`Getting submission from LeetCode, offset ${offset}`);

        const getSubmissions = async (maxRetries, retryCount = 0) => {
            try {
                const response = await axios.get('https://leetcode.com/api/submissions/', config);
                log(`Successfully fetched submission from LeetCode, offset ${offset}`);
                return response;
            } catch (exception) {
                if (retryCount >= maxRetries) {
                    throw exception;
                }
                log('Error fetching submissions, retrying in ' + 3 ** retryCount + ' seconds...');
                // There's a rate limit on LeetCode API, so wait with backoff before retrying.
                await delay(3 ** retryCount * 1000);
                return getSubmissions(maxRetries, retryCount + 1);
            }
        };
        // On the first attempt, there should be no rate limiting issues, so we fail immediately in case
        // the tokens are configured incorrectly.
        const maxRetries = (response === null) ? 0 : 5;
        if (response !== null) {
            // Add a 1 second delay before all requests after the initial request.
            await delay(1000);
        }
        response = await getSubmissions(maxRetries);

        if (!addToSubmissions({response, details, submissions_dict, submissions})) {
            break;
        }

        offset += 20;
    }
    while (response.data.has_next) ;

    // We have all submissions we want to write to GitHub now.
    // First, get the default branch to write to.
    const repoInfo = await octokit.repos.get({
        owner: owner,
        repo: repo,
    });
    const defaultBranch = repoInfo.data.default_branch;
    log(`Default branch for ${owner}/${repo}: ${defaultBranch}`);

    log(`Syncing ${submissions.length} submissions...`);
    let latestCommitSHA = commits.data[0].sha;
    let treeSHA = commits.data[0].commit.tree.sha;

    // Write in reverse order (oldest first), so that if there are errors, the last sync time is still valid.
    for (let i = submissions.length - 1; i >= 0; i--) {
        const submission = await getSubmissionDetails(submissions[i]);

        [treeSHA, latestCommitSHA] = await commit({
            octokit,
            owner,
            repo,
            defaultBranch,
            commitInfo,
            treeSHA,
            latestCommitSHA,
            submission
        });
    }
    log('Done syncing all submissions.');
}

module.exports = {log, sync}

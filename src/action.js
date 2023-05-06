const axios = require('axios');
const {Octokit} = require('@octokit/rest');
const {NodeHtmlMarkdown} = require('node-html-markdown');
const sprightly = require('sprightly')

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

    const treeData = [
        {
            path: `${submission.title}/solution.${LANG_TO_EXTENSION[submission.lang]}`,
            mode: '100644',
            content: submission.code,
        },
        {
            path: `${submission.title}/README.md`,
            mode: '100644',
            content: submission.readme,
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
        submissions
    } = params;

    for (const submission of response.data.submissions_dump) {
        if (submission.status !== 10) { // not accepted
            continue;
        }

        submissions.push({
            id: submission.id,
            titleSlug: submission.title_slug
        });
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
    // First, get the timestamp for when the syncer last ran.
    const commits = await octokit.repos.listCommits({
        owner: owner,
        repo: repo,
        per_page: 100,
    });

    const getSubmissionDetails = async (id, titleSlug) => {
        const config = {
            headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRFToken': leetcodeCSRFToken,
                'Cookie': `csrftoken=${leetcodeCSRFToken};LEETCODE_SESSION=${leetcodeSession};`,
            }
        };

        const gql = {
            "operationName": "submissionDetails",
            "query": `query submissionDetails($submissionId: Int!, $titleSlug: String!) {
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
              question(titleSlug: $titleSlug) {
                questionId
                title
                difficulty
                likes
                dislikes
                isLiked
                stats
                content
                topicTags {
                  name
                  slug
                }
                sampleTestCase
              }
            }`,
            "variables": {
                submissionId: id,
                titleSlug: titleSlug
            }
        };

        const resp = await axios.post('https://leetcode.com/graphql', gql, config);
        return resp;
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
        log(`Getting submissions from LeetCode, offset ${offset}`);

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

        if (!addToSubmissions({response, submissions})) {
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

    // Write in reverse order (oldest first)
    for (let i = submissions.length - 1; i >= 0; i--) {
        const detailsResponse = await getSubmissionDetails(submissions[i].id, submissions[i].titleSlug);
        const details = detailsResponse.data.data;

        const tags = [];
        for (const t in details.question.topicTags) {
            tags.push(`[${details.question.topicTags[t].name}](https://leetcode.com/tag/${details.question.topicTags[t].slug})`);
        }

        let submission = {
            id: submissions[i].id,
            slug: submissions[i].titleSlug,
            title: `${details.question.title} (${details.question.questionId})`,
            lang: details.submissionDetails.lang.name,
            timestamp: details.submissionDetails.timestamp,
            code: details.submissionDetails.code,
            question: NodeHtmlMarkdown.translate(details.question.content),
            social: {
                likes: details.question.likes,
                dislikes: details.question.dislikes,
                difficulty: details.question.difficulty,
                stats: details.question.stats,
            },
            tags: tags,
            perf: {
                runtimeDisplay: details.submissionDetails.runtimeDisplay,
                runtimePercentile: details.submissionDetails.runtimePercentile.toFixed(2),
                runtimeDistribution: details.submissionDetails.runtimeDistribution,
                memoryDisplay: details.submissionDetails.memoryDisplay,
                memoryPercentile: details.submissionDetails.memoryPercentile.toFixed(2),
                memoryDistribution: details.submissionDetails.memoryDistribution,
            }
        };

        submission.readme = sprightly.sprightly('./src/readme.tmpl', submission);

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

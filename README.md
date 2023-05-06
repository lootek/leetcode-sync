<p align="center">
    <img src="images/leetcode_sync.png" width="250"/>
</p>

# LeetCode Sync v2

GitHub Action for automatically syncing LeetCode submissions to a GitHub repository.

NOTE: This is a highly modified version of the fork source repo https://github.com/joshcai/leetcode-sync and thus tagged
v2.x.

## Features

- Synchronizes accepted solutions from LeetCode to the default branch of the GitHub repo
- Only syncs solutions that have not been synced before
- ~~Uploads the latest accepted solution for a single problem if there are multiple submissions per day~~
- **Uploads the problem description and solution metadata as well (rendered as README.md)**

## How to use

1. Login to LeetCode and obtain the `csrftoken` and `LEETCODE_SESSION` cookie values.

    - After logging in, right-click on the page and press `Inspect`.
    - Refresh the page.
    - Look for a network request to https://leetcode.com.
    - Look under `Request Headers` for the `cookie:` attribute to find the values.

2. Create a new GitHub repository to host the LeetCode submissions.

    - It can be either private or public.

3. Add the values from step 1
   as [GitHub secrets](https://docs.github.com/en/actions/configuring-and-managing-workflows/creating-and-storing-encrypted-secrets#creating-encrypted-secrets-for-a-repository),
   e.g. `LEETCODE_CSRF_TOKEN` and `LEETCODE_SESSION`.

4. Add a workflow file with this action under the `.github/workflows` directory, e.g. `sync_leetcode.yml`.

   Example workflow file:

   ```yaml
   name: Sync Leetcode

   on:
     workflow_dispatch:
     schedule:
       - cron: "0 8 * * 6"

   jobs:
     build:
       runs-on: ubuntu-latest

       steps:
         - name: Sync
           uses: lootek/leetcode-sync@v2.0.0
           with:
             github-token: ${{ github.token }}
             leetcode-csrf-token: ${{ secrets.LEETCODE_CSRF_TOKEN }}
             leetcode-session: ${{ secrets.LEETCODE_SESSION }}
   ```

5. After you've submitted a LeetCode solution, run the workflow by going to the `Actions` tab, clicking the action name,
   e.g. `Sync Leetcode`, and then clicking `Run workflow`. The workflow will also automatically run once a week by
   default (can be configured via the `cron` parameter).

## Inputs

- `github-token` _(required)_: The GitHub access token for pushing solutions to the repository
- `leetcode-csrf-token` _(required)_: The LeetCode CSRF token for retrieving submissions from LeetCode
- `leetcode-session` _(required)_: The LeetCode session value for retrieving submissions from LeetCode

## Contributing

#### Testing locally

If you want to test changes to the action locally without having to commit and run the workflow on GitHub, you can
edit `src/test_config.js` to have the required config values and then run:

`$ node index.js test`

If you're using Replit, you can also just use the `Run` button, which is already configured to the above command.

#### Adding a new workflow parameter

If you add a workflow parameter, please make sure to also add it in `src/test_config.js`, so that it can be tested
locally.

You will need to manually run:

`$ git add -f src/test_config.js`

Since this file is in the `.gitignore` file to avoid users accidentally committing their key information.

/**
 * @fileoverview Checks how secure the SSL configuration is for the given target
 * using SSL Labs online tool.
 */

/*
 * ------------------------------------------------------------------------------
 * Requirements
 * ------------------------------------------------------------------------------
 */

// HACK: Needed here because with TS `eslint-disable-line` doesn't work fine.

import { promisify } from 'util';

import { Category } from 'sonarwhal/dist/src/lib/enums/category';
import { debug as d } from 'sonarwhal/dist/src/lib/utils/debug';
import { IFetchEnd, IScanEnd, IRule, IRuleBuilder } from 'sonarwhal/dist/src/lib/types';
import { SSLLabsEndpoint, SSLLabsEndpointDetail, SSLLabsOptions, SSLLabsResult } from './rule-types';
import { RuleContext } from 'sonarwhal/dist/src/lib/rule-context';
import { RuleScope } from 'sonarwhal/dist/src/lib/enums/rulescope';

const debug = d(__filename);

/*
 * ------------------------------------------------------------------------------
 * Public
 * ------------------------------------------------------------------------------
 */

const rule: IRuleBuilder = {
    create(context: RuleContext): IRule {
        /** The promise that represents the scan by SSL Labs. */
        let promise: Promise<SSLLabsResult>;
        /** The minimum grade required to pass. */
        let minimumGrade: string = 'A-';
        /** The options to pass to the SSL Labs scanner. */
        let scanOptions: SSLLabsOptions = {
            all: 'done',
            fromCache: true,
            host: '',
            maxAge: 2
        };
        /** Error processing the request if any. */
        let failed: boolean = false;

        /**
         * Enum with the different possible grades for an endpoint returned by SSL Labs scan.
         *
         * https://github.com/ssllabs/ssllabs-scan/blob/stable/ssllabs-api-docs.md#endpoint
         */
        enum Grades {
            'A+' = 1,
            A,
            'A-',
            B,
            C,
            D,
            E,
            F,
            M,
            T
        }

        const loadRuleConfig = () => {
            minimumGrade = (context.ruleOptions && context.ruleOptions.grade) || 'A-';
            const userSslOptions = (context.ruleOptions && context.ruleOptions.ssllabs) || {};

            scanOptions = Object.assign(scanOptions, userSslOptions);
        };

        const verifyEndpoint = (resource: string) => {
            return (endpoint: SSLLabsEndpoint) => {
                const { grade, serverName = resource, details }: { grade: string, serverName: string, details: SSLLabsEndpointDetail } = endpoint;

                if (!grade && details.protocols.length === 0) {
                    const message = `${resource} doesn't support HTTPS.`;

                    debug(message);
                    context.report(resource, null, message);

                    return;
                }

                const calculatedGrade: Grades = Grades[grade];
                const calculatedMiniumGrade: Grades = Grades[minimumGrade];

                if (calculatedGrade > calculatedMiniumGrade) {
                    const message: string = `${serverName}'s grade ${grade} doesn't meet the minimum ${minimumGrade} required.`;

                    debug(message);
                    context.report(resource, null, message);
                } else {
                    debug(`Grade ${grade} for ${resource} is ok.`);
                }
            };
        };

        const notifyError = async (resource: string, error: any) => {
            debug(`Error getting data for ${resource} %O`, error);
            await context.report(resource, null, `Couldn't get results from SSL Labs for ${resource}.`);
        };

        const start = (data: IFetchEnd) => {
            const { resource }: { resource: string } = data;

            if (!resource.startsWith('https://')) {
                const message: string = `${resource} doesn't support HTTPS.`;

                debug(message);
                context.report(resource, null, message);

                return;
            }

            /*
             * HACK: Need to do a require here in order to be capable
             * of mocking when testing the rule and `import` doesn't
             * work here.
             */
            const ssl = require('node-ssllabs');
            const ssllabs: Function = promisify(ssl.scan);

            debug(`Starting SSL Labs scan for ${resource}`);
            scanOptions.host = resource;

            promise = ssllabs(scanOptions)
                .catch(async (error) => {
                    failed = true;
                    await notifyError(resource, error);
                });
        };

        const end = async (data: IScanEnd) => {
            const { resource }: { resource: string } = data;

            if (!promise || failed) {
                return;
            }

            debug(`Waiting for SSL Labs results for ${resource}`);
            let host: SSLLabsResult;

            try {
                host = await promise;
            } catch (e) {
                notifyError(resource, e);

                return;
            }

            debug(`Received SSL Labs results for ${resource}`);

            if (!host.endpoints || host.endpoints.length === 0) {
                const msg = `Didn't get any result for ${resource}.
There might be something wrong with SSL Labs servers.`;

                debug(msg);
                await context.report(resource, null, msg);

                return;
            }

            host.endpoints.forEach(verifyEndpoint(resource));
        };

        loadRuleConfig();

        /*
         * We are using `fetch::end::html` instead of `scan::start`
         * or `fetch::start` because the `ssllabs` API doesn't
         * follow the redirects, so we need to use the final url
         * (e.g.: https://developer.microsoft.com/en-us/microsoft-edge/
         * instead of http://edge.ms).
         */
        return {
            'fetch::end::html': start,
            'scan::end': end
        };
    },
    meta: {
        docs: {
            category: Category.security,
            description: 'Strength of your SSL configuration'
        },
        schema: [{
            additionalProperties: false,
            properties: {
                grade: {
                    pattern: '^(A\\+|A\\-|[A-F]|T|M)$',
                    type: 'string'
                },
                ssllabs: {
                    properties: {
                        all: {
                            pattern: '^(on|done)$',
                            type: 'string'
                        },
                        fromCache: { type: 'boolean' },
                        ignoreMismatch: { type: 'boolean' },
                        maxAge: {
                            minimum: 0,
                            type: 'integer'
                        },
                        publish: { type: 'boolean' },
                        startNew: { type: 'boolean' }
                    },
                    type: 'object'
                }
            },
            type: 'object'
        }],
        scope: RuleScope.site
    }
};

export default rule;

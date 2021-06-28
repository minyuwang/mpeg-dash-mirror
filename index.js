const xml2js = require('xml2js');
const request = require('request');
const url = require('url');
const { spawnSync } = require('child_process');
const { writeFileSync } = require('fs');
const commonPath = require('common-path');

function parseDashDuration(duration)
{
  "use strict";

  let d = 0;

  let h = duration.match(/^P.*[^\d](\d+)H.*$/);
  if (h)
    d += parseInt(h[1]) * 3600;

  let m = duration.match(/^P.*[^\d](\d+)M.*$/);
  if (m)
    d += parseInt(m[1]) * 60;

  let s = duration.match(/^P.*[^\d^\.](\d+)(\.*\d*)*S$/)
  if (s) {
    if (s[1])
      d += parseInt(s[1]);
    if (s[2])
      d += Number(s[2]);
  }

  return d;
}

function mirror(manifestUri)
{
  "use strict";

  return new Promise((resolve, reject) => {
      request(manifestUri, { gzip: true }, (error, response, body) => {
        if (error) reject(new Error(error));
        resolve(body);
      });
    })
    .then((text) => {
      return new Promise((resolve, reject) => {
        xml2js.parseString(text, (error, result) => {
          if (error) reject(new Error(error));
          resolve(result);
        });
      });
    })
    .then((manifest) => {
      let uris = [manifestUri];

      for (const period of manifest.MPD.Period) {
        let baseURL = url.resolve(manifestUri, '.');

        if (period.BaseURL) {
          baseURL = url.resolve(baseURL, period.BaseURL[0]);
        }

        for (const AdaptationSet of period.AdaptationSet) {
          for (const Representation of AdaptationSet.Representation) {
            const id = Representation.$.id;
            const SegmentTemplate = AdaptationSet.SegmentTemplate[0];

            let initSegmentURL = SegmentTemplate.$.initialization.replace(/\$RepresentationID\$/g, id);
            uris.push(url.resolve(baseURL, initSegmentURL));

            if (SegmentTemplate.SegmentTimeline) {
              const SegmentTimeline = SegmentTemplate.SegmentTimeline[0];
              let t = 0;
              for (const S of SegmentTimeline.S) {
                t = parseInt(S.$.t || t);
                let r = parseInt(S.$.r || 0);

                for (let i = 0; i <= r; i++) {
                  let segmentURL = SegmentTemplate.$.media
                    .replace(/\$RepresentationID\$/g, id)
                    .replace(/\$Time\$/g, t);
                  uris.push(url.resolve(baseURL, segmentURL));
                  t += parseInt(S.$.d);
                }
              }
            } else {
              let number = parseInt(SegmentTemplate.$.startNumber || 0);
              let totalDuration = parseDashDuration(period.duration || manifest.MPD.$.mediaPresentationDuration);
              let segmentDuration = parseInt(SegmentTemplate.$.duration);
              if (SegmentTemplate.$.timescale) {
                segmentDuration /= parseInt(SegmentTemplate.$.timescale);
              }

              for (let i = 0; i < Math.ceil(totalDuration / segmentDuration); i++) {
                let segmentURL = SegmentTemplate.$.media
                  .replace(/\$RepresentationID\$/g, id)
                  .replace(/\$Number(.*)\$/g, (str, format) => {
                    let match = format.match(/^%0(\d+)d$/);
                    if (match) {
                      let n = match[1];
                      return ('0'.repeat(n) + number).slice(-n);
                    }
                    return '' + number;
                  });
                uris.push(url.resolve(baseURL, segmentURL));
                number++;
              }
            }
          }
        }
      }

      return uris;
    })
    .then((uris) => {

      writeFileSync('mpeg_dash_mirror.txt', manifestUri);

      let success = 0;
      let fail = 0;

      commonPath(uris).parsedPaths.forEach(({ original, subPart, basePart}) => {
        process.stdout.write('[....] ' + subPart + basePart + '\r');
        let result = spawnSync('wget', ['-q', '-c', '-P', subPart, original]);
        if (result.error) {
          reject(new Error(result.error));
        } else {
          if (result.status === 0) {
            process.stdout.write('[\x1b[32m OK \x1b[0m] ' + subPart + basePart + '\n');
            success++;
          } else {
            process.stdout.write('[\x1b[31mFAIL\x1b[0m] ' + subPart + basePart + '\n');
            fail++;
          }
        }
      });

      console.log("%s: %d success %d fail", manifestUri, success, fail);
    });
}

if (process.argv.length != 3) {
  console.error(`USAGE: ${process.argv[1]} <Manifest URL>`);
  process.exit(1);
}

mirror(process.argv[2])
  .catch(console.error);

module.exports = function (RED) {

    function ImageFilters(config) {
        let SSIM = require('ssim.js');
        let Jimp = require('jimp');
        const isBase64 = require('is-base64');
        const _prefixURIMap = {
            "iVBOR": "data:image/png;base64,",
            "R0lGO": "data:image/gif;base64,",
            "/9j/4": "data:image/jpeg;base64,",
            "Qk02U": "data:image/bmp;base64,"
        }
        const createDataURI = function (rawImage) {
            let first5 = rawImage.substr(0, 5)
            if (_prefixURIMap[first5]) {
                return _prefixURIMap[first5] + rawImage;
            }
            return _prefixURIMap["iVBOR"] + rawImage;//default to png
        }


        RED.nodes.createNode(this, config);
        let node = this;
        node.ssimslider = config.ssimslider || 50;
        node.luminosityslider = config.luminosityslider || 50;

        node.on("input", function (msg) {
            //first clear any error status
            node.status({});
            let nodeStatusError = function (err, msg, statusText) {
                node.error(err, msg);
                node.status({fill: "red", shape: "dot", text: statusText});
            }

            let getImage = function (node, msg, data, dataType, processImage) {
                var dataInput = null;
                RED.util.evaluateNodeProperty(data, dataType, node, msg, (err, value) => {
                    if (err) {
                        node.error(err, msg);
                    } else {
                        dataInput = value;
                    }
                });
                if (dataInput == null) {
                    processImage("dataInput is null", null);
                    return;
                }

                let isBuffer = Buffer.isBuffer(dataInput);
                let hasMime = false, isBase64Image = false;
                if (typeof dataInput == "string") {
                    hasMime = dataInput.startsWith("data:");
                    isBase64Image = isBase64(dataInput, {mimeRequired: hasMime});
                    if (!isBase64Image) {
                        processImage("data is a string but not MIME or bas64 encoded image", null);
                        return;
                    }
                    if (!hasMime) {
                        dataInput = createDataURI(dataInput);
                        hasMime = true;
                    }
                }

                if (isBase64Image) {
                    if (hasMime) {
                        dataInput = dataInput.replace(/^data:image\/\w+;base64,/, "");//get data part only
                    }
                    Jimp.read(Buffer.from(dataInput, 'base64')).then(i => {
                        processImage(null, i);
                    }).catch(err => {
                        processImage(err, null);
                    });
                } else if (isBuffer) {
                    Jimp.read(dataInput).then(i => {
                        processImage(null, i);
                    }).catch(err => {
                        processImage(err, null);
                    });
                } else {
                    processImage(null, dataInput);
                }
            }

            let sRGBtoLin = function (colorChannel) {
                // Send this function a decimal sRGB gamma encoded color value
                // between 0.0 and 1.0, and it returns a linearized value.

                if (colorChannel <= 0.04045) {
                    return colorChannel / 12.92;
                } else {
                    return Math.pow(((colorChannel + 0.055) / 1.055), 2.4);
                }
            }

            let toPerceivedLuminance = function (Y) {
                // Send this function a luminance value between 0.0 and 1.0,
                // and it returns L* which is "perceptual lightness"

                if (Y <= (216 / 24389)) {       // The CIE standard states 0.008856 but 216/24389 is the intent for 0.008856451679036
                    return Y * (24389 / 27);  // The CIE standard states 903.3, but 24389/27 is the intent, making 903.296296296296296
                } else {
                    return Math.pow(Y, (1 / 3)) * 116 - 16;
                }
            }

            let calculatePerceivedLuminance = function (image) {
                let start = new Date();

                let luminanceSum = 0;
                for (let x = 0; x < image.bitmap.width; x++) {
                    for (let y = 0; y < image.bitmap.height; y++) {
                        let color = image.getPixelColor(x, y);
                        let r = (color >> 16) & 255;
                        let g = (color >> 8) & 255;
                        let b = color & 255;
                        let vR = r / 255.0;
                        let vG = g / 255.0;
                        let vB = b / 255.0;

                        let Y = (0.2126 * sRGBtoLin(vR) + 0.7152 * sRGBtoLin(vG) + 0.0722 * sRGBtoLin(vB));

                        luminanceSum += toPerceivedLuminance(Y);
                    }
                }
                let performance = new Date() - start;

                node.log("LuminanceSum: " + luminanceSum + " Performance: " + performance)
                return {
                    lum: (luminanceSum / (image.bitmap.width * image.bitmap.height)),
                    lumperf: performance
                };
            }

            try {
                getImage(node, msg, "payload", "msg", function (err, image) {
                    if (!image) {
                        nodeStatusError(err, msg, "Error. Image is null");
                        return;
                    } else {
                        getImage(node, msg, "ssimBaseline", "flow", function (err, baselineImage) {
                            const {lum, lumperf} = calculatePerceivedLuminance(image);
                            node.log("Luminance: " + lum + " Performance: " + lumperf + "ms")
                            if (lum < node.luminosityslider){
                                node.status({fill: "red", shape: "dot", text: "Luminance: " + lum.toFixed(2) + " Perf: " + lumperf + "ms"});
                                return;
                            }

                            let ssim = 0.0;
                            let ssimperf = 0.0;
                            if (baselineImage) {
                                const {mssim, performance} = SSIM.ssim(baselineImage.bitmap, image.bitmap);
                                node.log("SSIM: " + mssim + " Performance: " + performance + "ms")
                                ssim = mssim * 100.0;
                                ssimperf = performance;
                            }
                            if (ssim > node.ssimslider){
                                node.status({fill: "red", shape: "dot", text: "SSIM: " + ssim.toFixed(2) + " Perf: " + ssimperf + "ms"});
                                return;
                            }

                            node.status({fill: "green", shape: "dot", text: "Luminance: " + lum.toFixed(2) + " Perf: " + lumperf + "ms\nSSIM: " + ssim.toFixed(2) + " Perf: " + ssimperf + "ms"});
                            node.context().flow.set("ssimBaseline", image);
                            node.send(msg);
                        });
                    }
                });

            } catch (e) {
                nodeStatusError(e, msg, "Error comparing images")
            }
        });

    }

    RED.nodes.registerType('imagefilters', ImageFilters)

    ImageFilters.prototype.close = function () {
        try {
            this.context().flow.set("ssimBaseline", null);
            this.status({
                fill: "blue",
                shape: "dot",
                text: "EMPTY"
            });
        } catch (err) {
            this.error(err.message);
        }
    };
};

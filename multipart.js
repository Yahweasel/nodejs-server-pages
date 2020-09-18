/*
 * MIT License
 *
 * Copyright (c) 2020 David McGinnis
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// Parses string of format A=B.
// If B is quoted or a JSON structure, it is parsed. Otherwise, the entire value is returned.
// The returned struct has a single field with the given key and value pair.
function parseAssignment(str) {
  const result = {};
  const assignmentParts = str.split("=");
  if (assignmentParts.length == 2)
  {
    const fieldName = assignmentParts[0].trim();
    const fieldValue = assignmentParts[1].trim();
    try {
      result[fieldName] = JSON.parse(fieldValue);
    } catch (error) {
      result[fieldName] = fieldValue;
    }
  }
  return result;
};

// Reads through all of the headers in this part, until we hit two end lines in a row.
// We return a struct with the content disposition and type, as well as the offset to read next.
function parseHeaders(multipartBodyBuffer, startingIndex) {
  var lastline = "";
  var contentDisposition = "";
  var contentType = "";
  var i = startingIndex;
  var headerFound = false;

  for (; i < multipartBodyBuffer.length; i++) {
    const oneByte = multipartBodyBuffer.charCodeAt(i);
    const prevByte = i > 0 ? multipartBodyBuffer.charCodeAt(i-1) : null;
    const newLineDetected = oneByte == 0x0a && prevByte == 0x0d ? true : false;
    const newLineChar = oneByte == 0x0a || oneByte == 0x0d ? true : false;

    if (!newLineChar) lastline += String.fromCharCode(oneByte);

    if (newLineDetected) {
      const headerKey = lastline.split(":")[0].trim().toLowerCase()
      if (headerKey == '')
      {
        break;
      }
      headerFound = true;
      switch (headerKey) {
        case 'content-disposition':
          contentDisposition = lastline;
          break;
        case 'content-type':
          contentType = lastline;
          break;
        default:
          break;
      }
      lastline = "";
    }
  }
  return {
    contentDisposition: contentDisposition,
    contentType: contentType,
    endOffset: i + 1,
    headerFound: headerFound
  }
}

// Reads the data portion of the body, reading until we hit the boundary.
// We return a structure with the data and the next offset to read.
function parseData(multipartBodyBuffer, startingIndex, boundary) {
  var buffer = [];
  var lastline = ""
  for (i = startingIndex; i < multipartBodyBuffer.length; i++) {
    const oneByte = multipartBodyBuffer.charCodeAt(i);
    const prevByte = i > 0 ? multipartBodyBuffer.charCodeAt(i-1) : null;
    const newLineDetected = oneByte == 0x0a && prevByte == 0x0d ? true : false;
    const newLineChar = oneByte == 0x0a || oneByte == 0x0d ? true : false;

    if (!newLineChar) {
      lastline += String.fromCharCode(oneByte);
    }

    if (lastline.length > boundary.length + 4) {
      lastline = ""; // mem save
    }

    if ("--" + boundary == lastline) {
      break;
    } else {
      buffer.push(oneByte);
    }
    if (newLineDetected) {
      lastline = "";
    }
  }
  const dataLength = buffer.length - lastline.length;
  return {
    data: buffer.slice(0, dataLength - 1),
    endOffset: i + 3 // Include the new line
  }
}

// will transform this object:
// { header: 'Content-Disposition: form-data; name="uploads[]"; filename="A.txt"',
//	 info: 'Content-Type: text/plain',
//	 part: 'AAAABBBB' }
// into this one:
// { filename: 'A.txt', type: 'text/plain', data: <Buffer 41 41 41 41 42 42 42 42> }
function transformFieldInfo(field) {
  const newField = {}

  const dispositionParts = field.disposition.split(";");
  const assignments = dispositionParts.map(p => parseAssignment(p));
  const fileNames = assignments.filter(p => p.filename)
  if (fileNames.length > 0)
  {
    newField.filename = fileNames[0].filename
  } 
  const names = assignments.filter(p => p.name)
  if (names.length > 0)
  {
    newField.name = names[0].name
  }

  const contentTypeValue = field.type.split(":")[1]
  if (contentTypeValue)
  {
    const contentType = contentTypeValue.split(";")[0].trim();
    newField.type = contentType;
  }
  newField.data = new Buffer(field.data)
  return newField;
};

/**
 	Multipart Parser

	usage:

	var multipart = require('./multipart.js');
	var body = new Buffer("..."); 							   // raw body
	var body = new Buffer(event['body-json'].toString(),'base64'); // AWS case
	
	var boundary = multipart.getBoundary(event.params.header['content-type']);
	var parts = multipart.Parse(body,boundary);
	
	// each part is:
	// { filename: 'A.txt', type: 'text/plain', data: <Buffer 41 41 41 41 42 42 42 42> }

	author:  David McGinnis (mcginnda@davidmcginnis.net) www.davidmcginnis.net
			 Twitter: @DevMcDavid
 */
exports.Parse = function (multipartBodyBuffer, boundary) {
  var i = parseData(multipartBodyBuffer, 0, boundary).endOffset
  
  const allParts = [];

  while (i < multipartBodyBuffer.length) {
    const headerInfo = parseHeaders(multipartBodyBuffer, i);

    if (!headerInfo.headerFound)
    {
      break;
    }

    const info = parseData(multipartBodyBuffer, headerInfo.endOffset, boundary);
    i = info.endOffset;
    const fieldInfo = { disposition: headerInfo.contentDisposition, type: headerInfo.contentType, data: info.data };
    allParts.push(transformFieldInfo(fieldInfo));
  }
  return allParts;
};

//  read the boundary from the content-type header sent by the http client
//  this value may be similar to:
//  'multipart/form-data; boundary=----WebKitFormBoundaryvm5A9tzU1ONaGP5B',
exports.getBoundary = function (header) {
  const items = header.split(";");
  const boundaryItems = items.filter(item => item.indexOf("boundary") >= 0)
  if (boundaryItems.length == 0)
  {
    return "";
  }
  return parseAssignment(boundaryItems[0]).boundary;
};

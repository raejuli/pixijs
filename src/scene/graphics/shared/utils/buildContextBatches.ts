import { extensions, ExtensionType } from '../../../../extensions/Extensions';
import { Rectangle } from '../../../../maths/shapes/Rectangle';
import { buildSimpleUvs, buildUvs } from '../../../../rendering/renderers/shared/geometry/utils/buildUvs';
import { transformVertices } from '../../../../rendering/renderers/shared/geometry/utils/transformVertices';
import { Texture } from '../../../../rendering/renderers/shared/texture/Texture';
import { BigPool } from '../../../../utils/pool/PoolGroup';
import { BatchableGraphics } from '../BatchableGraphics';
import { buildCircle, buildEllipse, buildRoundedRectangle } from '../buildCommands/buildCircle';
import { buildLine } from '../buildCommands/buildLine';
import { buildPixelLine } from '../buildCommands/buildPixelLine';
import { buildPolygon } from '../buildCommands/buildPolygon';
import { buildRectangle } from '../buildCommands/buildRectangle';
import { buildTriangle } from '../buildCommands/buildTriangle';
import { triangulateWithHoles } from './triangulateWithHoles';

import type { Polygon } from '../../../../maths/shapes/Polygon';
import type { Topology } from '../../../../rendering/renderers/shared/geometry/const';
import type { ShapeBuildCommand } from '../buildCommands/ShapeBuildCommand';
import type { ConvertedFillStyle, ConvertedStrokeStyle } from '../FillTypes';
import type { GraphicsContext, TextureInstruction } from '../GraphicsContext';
import type { GpuGraphicsContext } from '../GraphicsContextSystem';
import type { GraphicsPath } from '../path/GraphicsPath';
import type { ShapePath } from '../path/ShapePath';

export const shapeBuilders: Record<string, ShapeBuildCommand> = {};

extensions.handleByMap(ExtensionType.ShapeBuilder, shapeBuilders);
extensions.add(buildRectangle, buildPolygon, buildTriangle, buildCircle, buildEllipse, buildRoundedRectangle);

const tempRect = new Rectangle();

export function buildContextBatches(context: GraphicsContext, gpuContext: GpuGraphicsContext)
{
    const { geometryData, batches } = gpuContext;

    // reset them..
    batches.length = 0;
    geometryData.indices.length = 0;
    geometryData.vertices.length = 0;
    geometryData.uvs.length = 0;

    for (let i = 0; i < context.instructions.length; i++)
    {
        const instruction = context.instructions[i];

        if (instruction.action === 'texture')
        {
            // add a quad!
            addTextureToGeometryData(instruction.data, batches, geometryData);
        }
        else if (instruction.action === 'fill' || instruction.action === 'stroke')
        {
            const isStroke = instruction.action === 'stroke';

            // build path collection of polys and shapes points..
            const shapePath = instruction.data.path.shapePath;

            const style = instruction.data.style;

            const hole = instruction.data.hole;

            if (isStroke && hole)
            {
                addShapePathToGeometryData(hole.shapePath, style, null, true, batches, geometryData);
            }

            addShapePathToGeometryData(shapePath, style, hole, isStroke, batches, geometryData);
        }
    }
}

function addTextureToGeometryData(
    data: TextureInstruction['data'],
    batches: BatchableGraphics[],
    geometryData: {
        vertices: number[];
        uvs: number[];
        indices: number[];
    }
)
{
    const { vertices, uvs, indices } = geometryData;

    const indexOffset = indices.length;
    const vertOffset = vertices.length / 2;

    const points: number[] = [];

    const build = shapeBuilders.rectangle;

    const rect = tempRect;

    const texture = data.image;

    rect.x = data.dx;
    rect.y = data.dy;
    rect.width = data.dw;
    rect.height = data.dh;

    const matrix = data.transform;

    // TODO - this can be cached...
    build.build(rect, points);

    if (matrix)
    {
        transformVertices(points, matrix);
    }

    build.triangulate(points, vertices, 2, vertOffset, indices, indexOffset);

    const textureUvs = texture.uvs;

    uvs.push(
        textureUvs.x0, textureUvs.y0,
        textureUvs.x1, textureUvs.y1,
        textureUvs.x3, textureUvs.y3,
        textureUvs.x2, textureUvs.y2,
    );

    const graphicsBatch = BigPool.get(BatchableGraphics);

    graphicsBatch.indexOffset = indexOffset;
    graphicsBatch.indexSize = indices.length - indexOffset;

    graphicsBatch.attributeOffset = vertOffset;
    graphicsBatch.attributeSize = (vertices.length / 2) - vertOffset;

    graphicsBatch.baseColor = data.style;
    graphicsBatch.alpha = data.alpha;

    graphicsBatch.texture = texture;
    graphicsBatch.geometryData = geometryData;

    batches.push(graphicsBatch);
}

function addShapePathToGeometryData(
    shapePath: ShapePath,
    style: ConvertedFillStyle | ConvertedStrokeStyle,
    hole: GraphicsPath,
    isStroke: boolean,
    batches: BatchableGraphics[],
    geometryData: {
        vertices: number[];
        uvs: number[];
        indices: number[];
    }
)
{
    const { vertices, uvs, indices } = geometryData;
    const lastIndex = shapePath.shapePrimitives.length - 1;

    shapePath.shapePrimitives.forEach(({ shape, transform: matrix }, i) =>
    {
        const indexOffset = indices.length;
        const vertOffset = vertices.length / 2;

        const points: number[] = [];

        const build = shapeBuilders[shape.type];
        let topology: Topology = 'triangle-list';
        // TODO - this can be cached...
        // TODO - THIS IS DONE TWICE!!!!!!
        // ONCE FOR STROKE AND ONCE FOR FILL
        // move to the ShapePath2D class itself?

        build.build(shape, points);

        if (matrix)
        {
            transformVertices(points, matrix);
        }

        if (!isStroke)
        {
            if (hole && lastIndex === i)
            {
                if (lastIndex !== 0)
                {
                    console.warn('[Pixi Graphics] only the last shape have be cut out');
                }

                const holeIndices: number[] = [];

                const otherPoints = points.slice();

                const holeArrays = getHoleArrays(hole.shapePath);

                holeArrays.forEach((holePoints) =>
                {
                    holeIndices.push(otherPoints.length / 2);
                    otherPoints.push(...holePoints);
                });

                triangulateWithHoles(otherPoints, holeIndices, vertices, 2, vertOffset, indices, indexOffset);
            }
            else
            {
                build.triangulate(points, vertices, 2, vertOffset, indices, indexOffset);
            }
        }
        else
        {
            const close = (shape as Polygon).closePath ?? true;
            const lineStyle = style as ConvertedStrokeStyle;

            if (!lineStyle.pixelLine)
            {
                buildLine(points, lineStyle, false, close, vertices, indices);
            }
            else
            {
                buildPixelLine(points, close, vertices, indices);
                topology = 'line-list';
            }
        }

        const uvsOffset = uvs.length / 2;

        const texture = style.texture;

        if (texture !== Texture.WHITE)
        {
            const textureMatrix = style.matrix;

            if (textureMatrix)
            {
                // todo can prolly do this before calculating uvs..
                if (matrix)
                {
                    textureMatrix.append(matrix.clone().invert());
                }

                buildUvs(vertices, 2, vertOffset, uvs, uvsOffset, 2, (vertices.length / 2) - vertOffset, textureMatrix);
            }
        }
        else
        {
            buildSimpleUvs(uvs, uvsOffset, 2, (vertices.length / 2) - vertOffset);
        }

        const graphicsBatch = BigPool.get(BatchableGraphics);

        graphicsBatch.indexOffset = indexOffset;
        graphicsBatch.indexSize = indices.length - indexOffset;

        graphicsBatch.attributeOffset = vertOffset;
        graphicsBatch.attributeSize = (vertices.length / 2) - vertOffset;

        graphicsBatch.baseColor = style.color;
        graphicsBatch.alpha = style.alpha;

        graphicsBatch.texture = texture;
        graphicsBatch.geometryData = geometryData;
        graphicsBatch.topology = topology;

        batches.push(graphicsBatch);
    });
}

function getHoleArrays(shape: ShapePath)
{
    if (!shape) return [];

    const holePrimitives = shape.shapePrimitives;

    const holeArrays = [];

    for (let k = 0; k < holePrimitives.length; k++)
    {
        const holePrimitive = holePrimitives[k].shape;

        // TODO - need to transform the points via there transform here..
        const holePoints: number[] = [];

        const holeBuilder = shapeBuilders[holePrimitive.type] as ShapeBuildCommand;

        holeBuilder.build(holePrimitive, holePoints);

        holeArrays.push(holePoints);
    }

    return holeArrays;
}

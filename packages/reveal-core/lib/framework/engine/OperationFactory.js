/**
 * Operation Factory
 * Instantiates discrete pipeline operations from declarative JSON definitions.
 */

const QuantizeOperation = require('./operations/QuantizeOperation');
const CullOperation = require('./operations/CullOperation');
const SubstrateDetectionOperation = require('./operations/SubstrateDetectionOperation');
const MapOperation = require('./operations/MapOperation');
const SnapLabOperation = require('./operations/SnapLabOperation');
const SnapOperation = require('./operations/SnapOperation');
const PeakFinderOperation = require('./operations/PeakFinderOperation');
const PruneOperation = require('./operations/PruneOperation');
const HijackOperation = require('./operations/HijackOperation');
const HijackSubstrateOperation = require('./operations/HijackSubstrateOperation');
const RescueOperation = require('./operations/RescueOperation');
const InjectOperation = require('./operations/InjectOperation');
const RefineOperation = require('./operations/RefineOperation');
const DistillOperation = require('./operations/DistillOperation');
const DensityFloorOperation = require('./operations/DensityFloorOperation');

class OperationFactory {
    static create(stepDef) {
        switch (stepDef.op) {
            case 'quantize': return new QuantizeOperation(stepDef);
            case 'cull': return new CullOperation(stepDef);
            case 'substrate_detection': return new SubstrateDetectionOperation(stepDef);
            case 'map': return new MapOperation(stepDef);
            case 'snap_lab': return new SnapLabOperation(stepDef);
            case 'snap': return new SnapOperation(stepDef);
            case 'peak_finder': return new PeakFinderOperation(stepDef);
            case 'prune': return new PruneOperation(stepDef);
            case 'hijack': return new HijackOperation(stepDef);
            case 'hijack_substrate': return new HijackSubstrateOperation(stepDef);
            case 'rescue': return new RescueOperation(stepDef);
            case 'inject': return new InjectOperation(stepDef);
            case 'refine': return new RefineOperation(stepDef);
            case 'distill': return new DistillOperation(stepDef);
            case 'density_floor': return new DensityFloorOperation(stepDef);
            
            default:
                throw new Error(`[OperationFactory] Unknown operation: ${stepDef.op}`);
        }
    }
}

module.exports = OperationFactory;
